import type { SkillBundleRef } from "@kobe/protocol";
import {
  and,
  eq,
  inArray,
  personalSkills,
  sql,
  personalSkillVersions,
  teamSkillVersions,
  type KobeTx,
} from "@kobe/db";
import { logger } from "../logger.js";
import type { SkillRef } from "../resolver/resolve.js";
import { blockedAmong, isBlocked } from "./blocklist.js";

/**
 * Skill materialization, server side (KOBE-82, D22). Two read paths, both inside a transaction and
 * both checking the site blocklist again in it:
 *
 * - {@link bundleRefsFor}: the run-start list. The resolver's effective skills (approved, not
 *   blocklisted, not team-disabled) become `{name, sha256, size}` refs in `run.start`; nothing else
 *   is ever listed, so nothing else reaches a sandbox.
 * - {@link locateBundle}: what a sandbox may download: only a hash listed in the `run.start` of a
 *   run active on that sandbox, and never a blocklisted one.
 */

/**
 * Ref list for `run.start` from the resolver's effective skills, blocklist re-checked here.
 * `unavailable` names the catalog skills (KOBE-315) whose runtime bundle this server does not hold:
 * Kobe's own versions always have theirs (KOBE-317), maintainer submissions until their packages
 * are stored (KOBE-333) do not. The caller reports them as omitted, never silently.
 */
export async function bundleRefsFor(
  tx: KobeTx,
  who: { teamId: string; userId: string },
  skills: readonly SkillRef[],
): Promise<SkillBundleRef[]> {
  return (await bundleRefsWithGaps(tx, who, skills)).refs;
}

export async function bundleRefsWithGaps(
  tx: KobeTx,
  who: { teamId: string; userId: string },
  skills: readonly SkillRef[],
): Promise<{ refs: SkillBundleRef[]; unavailable: string[] }> {
  if (skills.length === 0) return { refs: [], unavailable: [] };
  const hashes = skills.flatMap((s) => [s.hash, ...(s.aliases ?? [])]);
  const blocked = new Set(await blockedAmong(tx, hashes));
  const isBlocked = (s: SkillRef) =>
    blocked.has(s.hash) || (s.aliases ?? []).some((a) => blocked.has(a));
  const sizes = await sizesByHash(
    tx,
    who,
    skills.filter((s) => !isBlocked(s)).map((s) => s.hash),
  );
  const refs: SkillBundleRef[] = [];
  const unavailable: string[] = [];
  for (const skill of skills) {
    if (isBlocked(skill)) continue;
    const size = sizes.get(skill.hash);
    if (size === undefined) {
      if (skill.source === "catalog") {
        logger.warn({ name: skill.name, hash: skill.hash }, "skills: catalog bundle not stored");
        unavailable.push(skill.name);
        continue;
      }
      // A version row can't vanish (immutable, no delete); log rather than start a run without it.
      logger.error({ name: skill.name, hash: skill.hash }, "skills: effective bundle has no row");
      continue;
    }
    refs.push({ name: skill.name, sha256: skill.hash, size });
  }
  return { refs, unavailable };
}

async function sizesByHash(
  tx: KobeTx,
  who: { teamId: string; userId: string },
  hashes: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (hashes.length === 0) return sizes;
  const team = await tx
    .select({ hash: teamSkillVersions.contentHash, size: teamSkillVersions.sizeBytes })
    .from(teamSkillVersions)
    .where(
      and(
        eq(teamSkillVersions.teamId, who.teamId),
        inArray(teamSkillVersions.contentHash, [...hashes]),
      ),
    );
  const personal = await tx
    .select({ hash: personalSkillVersions.contentHash, size: personalSkillVersions.sizeBytes })
    .from(personalSkillVersions)
    .innerJoin(personalSkills, eq(personalSkills.id, personalSkillVersions.skillId))
    .where(
      and(
        eq(personalSkills.ownerUserId, who.userId),
        inArray(personalSkillVersions.contentHash, [...hashes]),
      ),
    );
  // Catalog versions with stored bytes (KOBE-317): site-wide, like the catalog itself; which ones
  // a run lists is the resolver's decision (the team's installs).
  const catalog = await tx.execute<{ hash: string; size: number }>(sql`
    SELECT DISTINCT runtime_hash AS hash, runtime_size_bytes AS size FROM registry_versions
    WHERE runtime_hash IN (${sql.join(
      hashes.map((h) => sql`${h}`),
      sql`, `,
    )}) AND runtime_storage_key IS NOT NULL`);
  for (const row of [...team, ...personal]) sizes.set(row.hash, row.size);
  for (const row of catalog.rows) if (!sizes.has(row.hash)) sizes.set(row.hash, Number(row.size));
  return sizes;
}

/**
 * A rescan suspended the version behind `hash` (KOBE-313) since the run started: a fetch is refused
 * as for a blocklisted hash, so a suspended version never loads on any path (KOBE-315). A team's
 * review row, a catalog version, or a personal version's own scan that this team has not approved
 * since.
 */
async function isSuspended(tx: KobeTx, teamId: string, hash: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM team_skill_reviews
     WHERE team_id = ${teamId} AND content_hash = ${hash} AND suspended_at IS NOT NULL
    UNION ALL
    SELECT 1 FROM registry_versions WHERE runtime_hash = ${hash} AND suspended_at IS NOT NULL
    UNION ALL
    SELECT 1 FROM personal_skill_versions v
      JOIN personal_skill_scans sc ON sc.skill_id = v.skill_id AND sc.version = v.version
     WHERE v.content_hash = ${hash} AND sc.suspended_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM team_skill_reviews r
         WHERE r.team_id = ${teamId} AND r.skill_id = v.skill_id AND r.version = v.version
           AND r.status = 'approved')
    LIMIT 1`);
  return rows.length > 0;
}

export interface LocatedBundle {
  readonly storageKey: string;
  readonly size: number;
}

/** The sandbox the request came from, as the verified token names it. */
export interface BundleCaller {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
}

/**
 * The stored bundle behind `hash`, if this sandbox may fetch it now: the hash is in the
 * `skill_bundles` of a `run.start` still open (not yet answered) for a run active on this very
 * sandbox, and it is not blocklisted at this moment. The list was decided at run start (resolver +
 * blocklist, same transaction), so approval changes or a replaced personal skill afterwards do not
 * break the run that was started with it, while a blocklist entry stops a fetch even mid-run.
 */
export async function locateBundle(
  tx: KobeTx,
  who: BundleCaller,
  hash: string,
): Promise<LocatedBundle | null> {
  if (await isBlocked(tx, hash)) return null;
  if (await isSuspended(tx, who.teamId, hash)) return null;
  const bound = await tx.execute(sql`
    SELECT 1
      FROM sandbox_run_leases l
      JOIN runs r ON r.team_id = l.team_id AND r.id = l.run_id
      JOIN sandbox_commands c
        ON c.team_id = l.team_id AND c.run_id = l.run_id AND c.kind = 'run.start'
     WHERE l.team_id = ${who.teamId} AND l.user_id = ${who.userId}
       AND l.sandbox_id = ${who.sandboxId}
       AND r.status IN ('running', 'waiting_approval')
       AND c.user_id = ${who.userId} AND c.status IN ('pending', 'delivered')
       AND c.frame -> 'config' -> 'skill_bundles'
           @> jsonb_build_array(jsonb_build_object('sha256', ${hash}::text))
     LIMIT 1`);
  if (bound.rows.length === 0) return null;
  // The bytes: this team's version with that hash, else one of the caller's own personal versions
  // (versions are immutable, so a replaced skill's old bytes are still there).
  const [team] = await tx
    .select({ key: teamSkillVersions.storageKey, size: teamSkillVersions.sizeBytes })
    .from(teamSkillVersions)
    .where(and(eq(teamSkillVersions.teamId, who.teamId), eq(teamSkillVersions.contentHash, hash)))
    .limit(1);
  if (team) return { storageKey: team.key, size: team.size };
  const [own] = await tx
    .select({ key: personalSkillVersions.storageKey, size: personalSkillVersions.sizeBytes })
    .from(personalSkillVersions)
    .innerJoin(personalSkills, eq(personalSkills.id, personalSkillVersions.skillId))
    .where(
      and(eq(personalSkills.ownerUserId, who.userId), eq(personalSkillVersions.contentHash, hash)),
    )
    .limit(1);
  if (own) return { storageKey: own.key, size: own.size };
  // A catalog version's bytes (KOBE-317): the run.start check above is what scopes it.
  const catalog = await tx.execute<{ key: string; size: number }>(sql`
    SELECT runtime_storage_key AS key, runtime_size_bytes AS size FROM registry_versions
    WHERE runtime_hash = ${hash} AND runtime_storage_key IS NOT NULL
    ORDER BY seq DESC LIMIT 1`);
  const row = catalog.rows[0];
  return row ? { storageKey: row.key, size: Number(row.size) } : null;
}
