import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { publishedVersions, runningVersion, type PublishedVersion } from "./install-versions.js";
import { lockSkillInstall, lockTeamSkillNames } from "./default-target.js";
import { readCatalogSwitches } from "./settings.js";

/**
 * A member's Add for me (KOBE-338, SK25): a catalog skill that loads only in this member's runs in
 * this team, at the version and pin mode they choose (`member_skill_enablements` with a version).
 * The resolver (`runs/catalog-facts.ts`) loads it in step 3 while the team switch "Members may add
 * catalog skills for themselves" is on, never for a skill the team blocked or installed Hidden.
 *
 * The rules mirror a team install's (`installCatalogSkill`): an approved version only (a deprecated
 * one is a Team admin's override, SK31; withdrawn, revoked, suspended and blocklisted versions
 * never), no add while the team blocks the skill (the database refuses it too, 0133), none of a
 * skill the team installed in any mode (the install governs; Request for team asks for another
 * version, review M3), and none whose name is one of the team's own skills (SK27). Installing
 * turns existing adds into the members' "on" choice for the install (`installAnswers`).
 */
export type PinMode = "pinned" | "within_major" | "latest";

export interface MemberAdd {
  readonly skillId: string;
  readonly name: string;
  readonly semver: string;
  readonly pinMode: PinMode;
  /** The version the member's runs load now, or null when none can (withdrawn, revoked). */
  readonly runs: string | null;
  readonly updatedAt: string;
}

export interface TeamMemberAdd extends MemberAdd {
  readonly userId: string;
  readonly memberName: string;
}

export type AddRefusal =
  | "not_found"
  | "no_version"
  | "not_installable"
  | "deprecated"
  | "blocked"
  | "adds_off"
  | "installed"
  | "name_clash";

export type AddResult =
  | {
      readonly ok: true;
      readonly semver: string;
      readonly pinMode: PinMode;
      readonly runs: string | null;
    }
  | { readonly ok: false; readonly code: AddRefusal };

const iso = (v: unknown) => new Date(v as string | Date).toISOString();

/** One writer of a member's choices in a team at a time (the enablement toggles take it too). */
async function lockMember(tx: KobeTx, teamId: string, userId: string): Promise<void> {
  const key = `kobe.skills.enablement:${teamId}:${userId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Why the team keeps this skill from member adds, if it does. */
async function teamGate(
  tx: KobeTx,
  teamId: string,
  skillId: string,
  name: string,
): Promise<AddRefusal | null> {
  if (!(await readCatalogSwitches(tx, teamId)).membersMayAdd) return "adds_off";
  const { rows } = await tx.execute<{ blocked: boolean; access: string | null; clash: boolean }>(
    sql`
    SELECT
      EXISTS (SELECT 1 FROM team_skill_blocks
               WHERE team_id = ${teamId} AND skill_id = ${skillId}) AS blocked,
      (SELECT access::text FROM team_skill_installs
        WHERE team_id = ${teamId} AND skill_id = ${skillId}) AS access,
      EXISTS (SELECT 1 FROM team_skills
               WHERE team_id = ${teamId} AND slug = ${name} AND archived_at IS NULL) AS clash`,
  );
  const r = rows[0];
  if (r?.blocked) return "blocked";
  // The team's install governs (review M3): a member asks for another version with Request for team.
  if (r?.access) return "installed";
  if (r?.clash) return "name_clash";
  return null;
}

/** The version a member may add: approved, not suspended, not blocklisted. */
function addable(
  versions: readonly PublishedVersion[],
  semver: string,
  current: string | undefined,
): PublishedVersion | AddRefusal {
  const v = versions.find((x) => x.semver === semver);
  if (!v) return "no_version";
  if (v.suspended || v.blocklisted) return "not_installable";
  // Keeping a version the member already has is no new install, even once it is deprecated.
  if (v.state === "deprecated") return v.id === current ? v : "deprecated";
  return v.state === "approved" ? v : "not_installable";
}

/** Adds a catalog skill for the member, or changes their add's version or pin mode. Audited. */
export function addForMe(
  db: KobeDb,
  input: {
    readonly teamId: string;
    readonly userId: string;
    readonly skillId: string;
    readonly version: string;
    readonly pinMode: PinMode;
  },
): Promise<AddResult> {
  const { teamId, userId, skillId } = input;
  return withTeam(db, teamId, async (tx): Promise<AddResult> => {
    await lockMember(tx, teamId, userId);
    // The install lock orders the add after a concurrent block (or install), so the block's
    // removal of adds and this add's block check see each other (`blockCatalogSkill`).
    await lockSkillInstall(tx, teamId, skillId);
    // The team's skill-name lock (review L1): a team skill made meanwhile sees this add's name.
    await lockTeamSkillNames(tx, teamId);
    const skill = await tx.execute<{ name: string }>(sql`
      SELECT name FROM registry_skills WHERE id = ${skillId} AND status <> 'archived'`);
    const name = skill.rows[0]?.name;
    if (!name) return { ok: false, code: "not_found" };
    const gate = await teamGate(tx, teamId, skillId, name);
    if (gate) return { ok: false, code: gate };
    const before = await tx.execute<{ version_id: string; semver: string; pin_mode: PinMode }>(
      sql`
      SELECT e.version_id, v.semver, e.pin_mode::text AS pin_mode
        FROM member_skill_enablements e JOIN registry_versions v ON v.id = e.version_id
       WHERE e.team_id = ${teamId} AND e.user_id = ${userId} AND e.catalog_skill_id = ${skillId}
         AND e.version_id IS NOT NULL
       FOR UPDATE OF e`,
    );
    const previous = before.rows[0];
    const versions = await publishedVersions(tx, skillId);
    const v = addable(versions, input.version, previous?.version_id);
    if (typeof v === "string") return { ok: false, code: v };
    await tx.execute(sql`
      INSERT INTO member_skill_enablements
        (team_id, user_id, catalog_skill_id, enabled, version_id, pin_mode)
      VALUES (${teamId}, ${userId}, ${skillId}, true, ${v.id}, ${input.pinMode}::skill_pin_mode)
      ON CONFLICT (team_id, user_id, catalog_skill_id) WHERE catalog_skill_id IS NOT NULL
      DO UPDATE SET enabled = true, version_id = EXCLUDED.version_id,
        pin_mode = EXCLUDED.pin_mode, updated_at = now()`);
    const runs = runningVersion(versions, { pinMode: input.pinMode, versionId: v.id });
    const target = { skillId, name, semver: v.semver, pinMode: input.pinMode };
    if (!previous) await recordAudit(tx, { action: "skill.member_add.added", teamId, target });
    else if (previous.version_id !== v.id || previous.pin_mode !== input.pinMode)
      await recordAudit(tx, {
        action: "skill.member_add.changed",
        teamId,
        target: { ...target, previous: { semver: previous.semver, pinMode: previous.pin_mode } },
      });
    return { ok: true, semver: v.semver, pinMode: input.pinMode, runs: runs?.semver ?? null };
  });
}

/** Removes the member's own add (their on/off choice for an install is not an add). Audited. */
export function removeMyAdd(
  db: KobeDb,
  input: { readonly teamId: string; readonly userId: string; readonly skillId: string },
): Promise<boolean> {
  const { teamId, userId, skillId } = input;
  return withTeam(db, teamId, async (tx) => {
    await lockMember(tx, teamId, userId);
    const removed = await tx.execute<{ name: string }>(sql`
      DELETE FROM member_skill_enablements e USING registry_skills s
       WHERE e.team_id = ${teamId} AND e.user_id = ${userId} AND e.catalog_skill_id = ${skillId}
         AND e.version_id IS NOT NULL AND s.id = e.catalog_skill_id
      RETURNING s.name`);
    const name = removed.rows[0]?.name;
    if (!name) return false;
    await recordAudit(tx, {
      action: "skill.member_add.removed",
      teamId,
      target: { skillId, name },
    });
    return true;
  });
}

type AddRow = {
  user_id: string;
  member_name: string;
  skill_id: string;
  name: string;
  version_id: string;
  semver: string;
  pin_mode: PinMode;
  updated_at: Date;
};

/** The adds in the team (one member's with `userId`), with the version each runs now. */
async function addsIn(tx: KobeTx, teamId: string, userId?: string): Promise<TeamMemberAdd[]> {
  const { rows } = await tx.execute<AddRow>(sql`
    SELECT e.user_id, u.name AS member_name, e.catalog_skill_id AS skill_id, s.name,
      e.version_id, v.semver, e.pin_mode::text AS pin_mode, e.updated_at
      FROM member_skill_enablements e
      JOIN registry_skills s ON s.id = e.catalog_skill_id
      JOIN registry_versions v ON v.id = e.version_id
      JOIN users u ON u.id = e.user_id
     WHERE e.team_id = ${teamId} AND e.version_id IS NOT NULL AND e.enabled
       ${userId ? sql`AND e.user_id = ${userId}` : sql``}
     ORDER BY s.name, u.name`);
  const versions = new Map<string, PublishedVersion[]>();
  for (const id of new Set(rows.map((r) => r.skill_id)))
    versions.set(id, await publishedVersions(tx, id));
  return rows.map((r) => ({
    userId: r.user_id,
    memberName: r.member_name,
    skillId: r.skill_id,
    name: r.name,
    semver: r.semver,
    pinMode: r.pin_mode,
    runs:
      runningVersion(versions.get(r.skill_id) ?? [], {
        pinMode: r.pin_mode,
        versionId: r.version_id,
      })?.semver ?? null,
    updatedAt: iso(r.updated_at),
  }));
}

/** The member's own adds in the team. */
export function listMyAdds(db: KobeDb, teamId: string, userId: string): Promise<MemberAdd[]> {
  return withTeam(db, teamId, async (tx) =>
    (await addsIn(tx, teamId, userId)).map(
      ({ userId: _u, memberName: _m, ...add }): MemberAdd => add,
    ),
  );
}

/** Every member's adds in the team: the Team console's list (SK25). */
export function listTeamMemberAdds(db: KobeDb, teamId: string): Promise<TeamMemberAdd[]> {
  return withTeam(db, teamId, (tx) => addsIn(tx, teamId));
}
