import { sql, type KobeDb, type KobeTx } from "@kobe/db";

/**
 * Shared pieces of the Default tag (KOBE-314, SK6–SK8): the locks that keep tag changes, new
 * teams and team uninstalls consistent with the Default sync, and the version a Default install
 * gets.
 *
 * Locks (transaction-level advisory locks, released at commit):
 * - **Default set:** changing the Default tag (or moving its major) takes it exclusively and queues
 *   the sync job in the same transaction; creating a team, uninstalling and reinstalling take it
 *   shared. So a new team either commits before a tag change (and the job then sees it) or reads
 *   the tag after it; and an uninstall reads the tag the sync acts on.
 * - **Install:** one per (team, skill): a sync step and a team's uninstall or reinstall of that
 *   skill never interleave, so an opt-out recorded meanwhile is never overwritten by an install.
 */
const DEFAULT_SET_LOCK = "kobe.skills.default-set";

export async function lockDefaultSet(tx: KobeTx, mode: "shared" | "exclusive"): Promise<void> {
  await (mode === "shared"
    ? tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${DEFAULT_SET_LOCK}, 0))`)
    : tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${DEFAULT_SET_LOCK}, 0))`));
}

export async function lockInstall(tx: KobeTx, teamId: string, skillId: string): Promise<void> {
  const key = `kobe.skills.install:${teamId}:${skillId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** The major of a semver string (the registry check guarantees the format). */
export const majorOf = (semver: string): number => Number(semver.split(".", 1)[0]);

export interface TargetVersion {
  readonly id: string;
  readonly semver: string;
  readonly major: number;
}

/**
 * The newest installable version of a catalog skill, optionally within one major: approved (not
 * deprecated, withdrawn or revoked) and not suspended by a rescan. Semver rises with `seq`.
 */
export async function newestApproved(
  db: KobeDb | KobeTx,
  skillId: string,
  major?: number,
): Promise<TargetVersion | null> {
  const inMajor =
    major === undefined ? sql`` : sql`AND split_part(semver, '.', 1)::integer = ${major}`;
  const { rows } = await db.execute<{ id: string; semver: string }>(sql`
    SELECT id, semver FROM registry_versions
    WHERE skill_id = ${skillId} AND state = 'approved' AND suspended_at IS NULL ${inMajor}
    ORDER BY seq DESC LIMIT 1`);
  const row = rows[0];
  return row ? { id: row.id, semver: row.semver, major: majorOf(row.semver) } : null;
}

/** The Default system tag's id (seeded by migration 0133). */
export async function defaultTagId(db: KobeDb | KobeTx): Promise<string> {
  const { rows } = await db.execute<{ id: string }>(
    sql`SELECT id FROM registry_tags WHERE kind = 'system' AND name = 'default'`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("skills: the Default system tag is missing (migration 0133)");
  return id;
}

export async function isDefaultSkill(db: KobeDb | KobeTx, skillId: string): Promise<boolean> {
  const { rows } = await db.execute(sql`
    SELECT 1 FROM registry_skill_tags st JOIN registry_tags t ON t.id = st.tag_id
    WHERE st.skill_id = ${skillId} AND t.kind = 'system' AND t.name = 'default'`);
  return rows.length > 0;
}

export interface DefaultTarget {
  readonly skillId: string;
  readonly name: string;
  /** The major Default installs follow (the newest `add` or `move_major` job's, by `seq`). */
  readonly major: number;
  /** Who tagged it (or last moved its major): the installer a Default install names. */
  readonly requestedBy: string;
}

/**
 * What every Default skill installs as in a team today: its name, the major Default installs
 * follow and who set it. Skills tagged Default without a sync job (none in practice) are left out.
 */
export async function defaultTargets(
  db: KobeDb | KobeTx,
  skillId?: string,
): Promise<DefaultTarget[]> {
  const only = skillId === undefined ? sql`` : sql`AND s.id = ${skillId}`;
  const { rows } = await db.execute<{
    skill_id: string;
    name: string;
    major: number;
    requested_by: string;
  }>(sql`
    SELECT DISTINCT ON (s.id) s.id AS skill_id, s.name, j.major, j.requested_by
    FROM registry_skills s
    JOIN registry_skill_tags st ON st.skill_id = s.id
    JOIN registry_tags t ON t.id = st.tag_id AND t.kind = 'system' AND t.name = 'default'
    JOIN skill_default_syncs j ON j.skill_id = s.id AND j.kind IN ('add', 'move_major')
    WHERE true ${only}
    ORDER BY s.id, j.seq DESC`);
  return rows.map((r) => ({
    skillId: r.skill_id,
    name: r.name,
    major: Number(r.major),
    requestedBy: r.requested_by,
  }));
}

/** The version a Default install of `target` gets now: the newest approved in its major. */
export async function defaultVersion(
  db: KobeDb | KobeTx,
  target: DefaultTarget,
): Promise<TargetVersion | null> {
  return newestApproved(db, target.skillId, target.major);
}
