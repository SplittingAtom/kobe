import { sql, type KobeTx } from "@kobe/db";
import {
  defaultTargets,
  defaultVersion,
  lockDefaultSet,
  lockInstall,
  type TargetVersion,
} from "./default-target.js";

/**
 * One team's step of a Default sync (KOBE-314, SK6–SK8), run inside that team's `withTeam`
 * transaction. Every step is idempotent, so a job resumed after a crash may repeat a team safely.
 */
export interface TeamStepResult {
  readonly installed: number;
  readonly kept: number;
  readonly optedOut: number;
  readonly converted: number;
  readonly optoutsCleared: number;
  readonly moved: number;
}

export const NOTHING: TeamStepResult = {
  installed: 0,
  kept: 0,
  optedOut: 0,
  converted: 0,
  optoutsCleared: 0,
  moved: 0,
};

/**
 * `add`: installs the skill On by default, Track within major, origin `default_tag` (SK6); a team
 * that opted out is skipped (SK7) and a team with its own install keeps its settings (SK8).
 */
export async function addInTeam(
  tx: KobeTx,
  teamId: string,
  skillId: string,
  version: TargetVersion,
  installedBy: string,
): Promise<TeamStepResult> {
  await lockInstall(tx, teamId, skillId);
  const optout = await tx.execute(sql`
    SELECT 1 FROM team_skill_optouts WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
  if (optout.rows.length > 0) return { ...NOTHING, optedOut: 1 };
  const inserted = await tx.execute(sql`
    INSERT INTO team_skill_installs
      (team_id, skill_id, version_id, pin_mode, access, origin, installed_by)
    VALUES (${teamId}, ${skillId}, ${version.id}, 'within_major', 'default_on', 'default_tag',
      ${installedBy})
    ON CONFLICT (team_id, skill_id) DO NOTHING
    RETURNING 1`);
  return inserted.rows.length > 0 ? { ...NOTHING, installed: 1 } : { ...NOTHING, kept: 1 };
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
 * `move_major`: moves the install to `version` only when it is still the tag's own (origin
 * `default_tag`), still Track within major, and on an older major (SK6). A team that pinned,
 * switched to Track latest, or installed the skill itself keeps its choice.
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
      AND i.pin_mode = 'within_major' AND v.id = i.version_id
      AND split_part(v.semver, '.', 1)::integer < ${version.major}
    RETURNING 1`);
  return { ...NOTHING, moved: moved.rows.length };
}

/**
 * A new team gets every Default skill at creation (SK8), in the team's creation transaction (under
 * its `withTeam`). The shared Default-set lock orders this against tag changes: a tag change that
 * commits first is seen here; one that commits later queues a job that sees this team.
 */
export async function installDefaultsInNewTeam(tx: KobeTx, teamId: string): Promise<number> {
  await lockDefaultSet(tx, "shared");
  let installed = 0;
  for (const target of await defaultTargets(tx)) {
    const version = await defaultVersion(tx, target);
    if (!version) continue;
    const step = await addInTeam(tx, teamId, target.skillId, version, target.requestedBy);
    installed += step.installed;
  }
  return installed;
}
