import { sql, withTeam, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { lockSkillInstall } from "./default-target.js";

/**
 * A Team admin's block of a catalog skill in the team (KOBE-338, SK25): members' adds of it are
 * removed (the 0133 trigger on `team_skill_blocks`, in the same transaction) and new ones refused
 * (the trigger on `member_skill_enablements`, and `addForMe` first with a clear answer). A blocked
 * skill can't be installed, reinstalled as a removed default, or reached by the Default sync.
 *
 * A skill the team has installed is not blocked: the Team admin uninstalls it first (on a Site
 * default that records the opt-out), so a block never silently switches off an install.
 */
export interface TeamBlock {
  readonly skillId: string;
  readonly name: string;
  readonly blockedBy: string;
  readonly blockedByName: string;
  readonly at: string;
}

export type BlockResult =
  | { readonly ok: true; readonly changed: boolean; readonly addsRemoved: number }
  | { readonly ok: false; readonly code: "not_found" | "installed" };

export function blockCatalogSkill(
  db: KobeDb,
  input: { readonly teamId: string; readonly skillId: string; readonly userId: string },
): Promise<BlockResult> {
  const { teamId, skillId } = input;
  return withTeam(db, teamId, async (tx): Promise<BlockResult> => {
    // The install lock: an install racing the block sees it, or the block sees the install.
    await lockSkillInstall(tx, teamId, skillId);
    const skill = await tx.execute<{ name: string }>(
      sql`SELECT name FROM registry_skills WHERE id = ${skillId}`,
    );
    const name = skill.rows[0]?.name;
    if (!name) return { ok: false, code: "not_found" };
    const installed = await tx.execute(sql`
      SELECT 1 FROM team_skill_installs WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
    if (installed.rows.length > 0) return { ok: false, code: "installed" };
    const adds = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM member_skill_enablements
       WHERE team_id = ${teamId} AND catalog_skill_id = ${skillId} AND version_id IS NOT NULL`);
    const inserted = await tx.execute(sql`
      INSERT INTO team_skill_blocks (team_id, skill_id, blocked_by)
      VALUES (${teamId}, ${skillId}, ${input.userId})
      ON CONFLICT (team_id, skill_id) DO NOTHING
      RETURNING 1`);
    if (inserted.rows.length === 0) return { ok: true, changed: false, addsRemoved: 0 };
    const addsRemoved = Number(adds.rows[0]?.n ?? 0);
    await recordAudit(tx, {
      action: "skill.catalog.blocked",
      teamId,
      target: { skillId, name, addsRemoved },
    });
    return { ok: true, changed: true, addsRemoved };
  });
}

export function unblockCatalogSkill(
  db: KobeDb,
  input: { readonly teamId: string; readonly skillId: string },
): Promise<boolean> {
  const { teamId, skillId } = input;
  return withTeam(db, teamId, async (tx) => {
    await lockSkillInstall(tx, teamId, skillId);
    const removed = await tx.execute<{ name: string }>(sql`
      DELETE FROM team_skill_blocks b USING registry_skills s
       WHERE b.team_id = ${teamId} AND b.skill_id = ${skillId} AND s.id = b.skill_id
      RETURNING s.name`);
    const name = removed.rows[0]?.name;
    if (!name) return false;
    await recordAudit(tx, { action: "skill.catalog.unblocked", teamId, target: { skillId, name } });
    return true;
  });
}

export function listTeamBlocks(db: KobeDb, teamId: string): Promise<TeamBlock[]> {
  return withTeam(db, teamId, async (tx) => {
    const { rows } = await tx.execute<{
      skill_id: string;
      name: string;
      blocked_by: string;
      by_name: string;
      at: Date;
    }>(sql`
      SELECT b.skill_id, s.name, b.blocked_by, u.name AS by_name, b.at
        FROM team_skill_blocks b
        JOIN registry_skills s ON s.id = b.skill_id
        JOIN users u ON u.id = b.blocked_by
       WHERE b.team_id = ${teamId}
       ORDER BY s.name`);
    return rows.map((r) => ({
      skillId: r.skill_id,
      name: r.name,
      blockedBy: r.blocked_by,
      blockedByName: r.by_name,
      at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
    }));
  });
}
