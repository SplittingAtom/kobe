import { SYSTEM_ACTOR, sql, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import {
  defaultTargets,
  defaultVersion,
  lockDefaultSet,
  lockInstall,
  lockTeamSkillNames,
  type TargetVersion,
} from "./default-target.js";

/**
 * One team's step of a Default sync (KOBE-314, SK6–SK8), run inside that team's `withTeam`
 * transaction. Every step is idempotent, so a job resumed after a crash may repeat a team safely.
 */
export interface TeamStepResult {
  readonly installed: number;
  /** The team already had an install (its own, or the tag's: see `present`). */
  readonly kept: number;
  readonly optedOut: number;
  /** The team blocked the skill (SK25): the sync never installs it there. */
  readonly blocked: number;
  /** The team has its own unarchived skill of the same name (SK27): skipped there. */
  readonly nameConflicts: number;
  readonly converted: number;
  readonly optoutsCleared: number;
  readonly moved: number;
  /** The kept install is already the tag's (e.g. made by the new-team hook): nothing to tell. */
  readonly present: number;
}

export const NOTHING: TeamStepResult = {
  installed: 0,
  kept: 0,
  optedOut: 0,
  blocked: 0,
  nameConflicts: 0,
  converted: 0,
  optoutsCleared: 0,
  moved: 0,
  present: 0,
};

// A version still installable when the step runs (it may have been withdrawn or suspended since).
const installable = (versionId: string) => sql`
  SELECT 1 FROM registry_versions
  WHERE id = ${versionId} AND state = 'approved' AND suspended_at IS NULL`;

/**
 * `add`: installs the skill On by default, Track within major, origin `default_tag` (SK6). A team
 * that opted out (SK7) or blocked the skill (SK25) is skipped; a team with its own install keeps
 * its settings (SK8). A team with its own unarchived skill of the same name is skipped too
 * (coordinator decision, SK27's name-clash rule): its audit shows `name_conflict`, so the Team
 * admin can rename or archive their skill and reinstall the default.
 */
export async function addInTeam(
  tx: KobeTx,
  teamId: string,
  skillId: string,
  version: TargetVersion,
  installedBy: string,
): Promise<TeamStepResult> {
  await lockInstall(tx, teamId, skillId);
  await lockTeamSkillNames(tx, teamId);
  const blocked = await tx.execute(sql`
    SELECT 1 FROM team_skill_blocks WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
  if (blocked.rows.length > 0) return { ...NOTHING, blocked: 1 };
  const optout = await tx.execute(sql`
    SELECT 1 FROM team_skill_optouts WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
  if (optout.rows.length > 0) return { ...NOTHING, optedOut: 1 };
  const clash = await tx.execute(sql`
    SELECT 1 FROM team_skills t JOIN registry_skills s ON s.name = t.slug
    WHERE t.team_id = ${teamId} AND s.id = ${skillId} AND t.archived_at IS NULL`);
  if (clash.rows.length > 0) {
    const has = await tx.execute(sql`
      SELECT 1 FROM team_skill_installs WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
    // An install made before the team skill (an archived one revived) is the team's to keep.
    if (has.rows.length === 0) return { ...NOTHING, nameConflicts: 1 };
  }
  const inserted = await tx.execute(sql`
    INSERT INTO team_skill_installs
      (team_id, skill_id, version_id, pin_mode, access, origin, installed_by)
    SELECT ${teamId}, ${skillId}, ${version.id}, 'within_major', 'default_on', 'default_tag',
      ${installedBy}
    WHERE EXISTS (${installable(version.id)})
    ON CONFLICT (team_id, skill_id) DO NOTHING
    RETURNING 1`);
  if (inserted.rows.length > 0) return { ...NOTHING, installed: 1 };
  const existing = await tx.execute<{ origin: string }>(sql`
    SELECT origin FROM team_skill_installs WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
  const origin = existing.rows[0]?.origin;
  if (!origin) return NOTHING;
  return { ...NOTHING, kept: 1, present: origin === "default_tag" ? 1 : 0 };
}

/**
 * `remove`: nothing running changes (SK8). Tag-made installs become ordinary team installs and the
 * team's opt-out of the skill is cleared; `kept` counts installs the team made itself.
 */
export async function removeInTeam(
  tx: KobeTx,
  teamId: string,
  skillId: string,
): Promise<TeamStepResult> {
  await lockInstall(tx, teamId, skillId);
  const own = await tx.execute(sql`
    SELECT 1 FROM team_skill_installs
    WHERE team_id = ${teamId} AND skill_id = ${skillId} AND origin = 'team'`);
  const converted = await tx.execute(sql`
    UPDATE team_skill_installs SET origin = 'team', updated_at = now()
    WHERE team_id = ${teamId} AND skill_id = ${skillId} AND origin = 'default_tag'
    RETURNING 1`);
  const cleared = await tx.execute(sql`
    DELETE FROM team_skill_optouts WHERE team_id = ${teamId} AND skill_id = ${skillId}
    RETURNING 1`);
  return {
    ...NOTHING,
    kept: own.rows.length,
    converted: converted.rows.length,
    optoutsCleared: cleared.rows.length,
  };
}

/**
 * `move_major`: moves the install to `version` only when it is untouched (SK6): still the tag's
 * own (origin `default_tag`), never changed by the team (`team_changed_at` null: no pin mode,
 * access or origin change), still Track within major, and on an older major. A touched install
 * keeps the team's choice for good.
 */
export async function moveInTeam(
  tx: KobeTx,
  teamId: string,
  skillId: string,
  version: TargetVersion,
): Promise<TeamStepResult> {
  await lockInstall(tx, teamId, skillId);
  const moved = await tx.execute(sql`
    UPDATE team_skill_installs i SET version_id = ${version.id}, updated_at = now()
    FROM registry_versions v
    WHERE i.team_id = ${teamId} AND i.skill_id = ${skillId} AND i.origin = 'default_tag'
      AND i.team_changed_at IS NULL AND i.pin_mode = 'within_major' AND v.id = i.version_id
      AND split_part(v.semver, '.', 1)::integer < ${version.major}
      AND EXISTS (${installable(version.id)})
    RETURNING 1`);
  return { ...NOTHING, moved: moved.rows.length };
}

export type AppliedChange =
  "installed" | "converted" | "optout_cleared" | "moved" | "name_conflict";

/** What a step changed in the team, for the team's audit (SK8, spec §421: installs, pin moves). */
export function changesOf(step: TeamStepResult): AppliedChange[] {
  return [
    ...(step.installed > 0 ? (["installed"] as const) : []),
    ...(step.converted > 0 ? (["converted"] as const) : []),
    ...(step.optoutsCleared > 0 ? (["optout_cleared"] as const) : []),
    ...(step.moved > 0 ? (["moved"] as const) : []),
    ...(step.nameConflicts > 0 ? (["name_conflict"] as const) : []),
  ];
}

/** Records each change a Default sync or the new-team hook made in the team (system actor). */
export async function auditApplied(
  tx: KobeTx,
  teamId: string,
  skill: { readonly id: string; readonly name: string },
  changes: readonly AppliedChange[],
  semver: string | null,
): Promise<void> {
  for (const change of changes)
    await recordAudit(tx, {
      action: "skill.default.applied",
      actor: SYSTEM_ACTOR,
      teamId,
      target: {
        skillId: skill.id,
        name: skill.name,
        change,
        ...(semver && (change === "installed" || change === "moved") ? { semver } : {}),
      },
    });
}

/**
 * A new team gets every Default skill at creation (SK8), in the team's creation transaction (under
 * its `withTeam`), each install audited in the team. The shared Default-set lock orders this
 * against tag changes: a tag change that commits first is seen here; one that commits later queues
 * a job that sees this team.
 */
export async function installDefaultsInNewTeam(tx: KobeTx, teamId: string): Promise<number> {
  await lockDefaultSet(tx, "shared");
  const targets = await defaultTargets(tx);
  // The lock order of every other path (Default set, install, names): every install lock first,
  // then the names lock, before any step re-takes them (review N4 of KOBE-316).
  for (const target of targets) await lockInstall(tx, teamId, target.skillId);
  await lockTeamSkillNames(tx, teamId);
  let installed = 0;
  for (const target of targets) {
    const version = await defaultVersion(tx, target);
    if (!version) continue;
    const step = await addInTeam(tx, teamId, target.skillId, version, target.requestedBy);
    await auditApplied(
      tx,
      teamId,
      { id: target.skillId, name: target.name },
      changesOf(step),
      version.semver,
    );
    installed += step.installed;
  }
  return installed;
}
