import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
/**
 * Most team skills one team may offer to all agents (KOBE-297), now On by default plus Required.
 * With an agent's own (at most 32, agent file) a run stays near the run.start cap; the resolver
 * still caps the run itself.
 */
export const MAX_OFFERED_SKILLS = 32;

/**
 * A team skill's access mode (KOBE-316, SK25), replacing KOBE-297's "Offer to all agents":
 * **Available** (members turn it on), **On by default** (members may turn it off), **Required**
 * (loads in every run of the team; Team admins only) or **Hidden** (only for agents that name it).
 * `offer_to_all` is kept in step (On by default) so a rollback to a release before KOBE-315 keeps
 * today's runs. Every change is audited. The team's skills On by default or Required are capped at
 * {@link MAX_OFFERED_SKILLS}; the Team console warns from {@link REQUIRED_WARN_AT} Required ones.
 */
export type SkillAccess = "available" | "default_on" | "required" | "hidden";

/** The Team console warns at this many Required skills (SK27: they count first against the cap). */
export const REQUIRED_WARN_AT = 5;

/** Required team skills (unarchived) and Required installs: what loads in every run (SK27). */
export async function requiredCount(tx: KobeTx, teamId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT (SELECT count(*) FROM team_skills
             WHERE team_id = ${teamId} AND access = 'required' AND archived_at IS NULL)
         + (SELECT count(*) FROM team_skill_installs
             WHERE team_id = ${teamId} AND access = 'required') AS n`);
  return Number(rows[0]?.n ?? 0);
}

export type AccessResult =
  | {
      readonly ok: true;
      readonly access: SkillAccess;
      readonly requiredCount: number;
      readonly warning?: "many_required";
    }
  | { readonly ok: false; readonly code: "not_found" | "forbidden" | "offer_limit" };

/**
 * Sets the access mode of team skill `skillId`. `mayRequire` (a Team admin) is needed to make a
 * skill Required and to change a Required one: a Builder can neither add nor remove Required.
 */
export function setTeamSkillAccess(
  db: KobeDb,
  input: {
    readonly teamId: string;
    readonly skillId: string;
    readonly access: SkillAccess;
    readonly mayRequire: boolean;
    /** Refuse (`forbidden`) unless the current mode is one of these (the legacy offer route). */
    readonly onlyFrom?: readonly SkillAccess[];
    /** Also record the legacy `skill.offer.changed` (the offer route). */
    readonly offerAudit?: boolean;
  },
): Promise<AccessResult> {
  const { teamId, skillId, access } = input;
  return withTeam(db, teamId, async (tx): Promise<AccessResult> => {
    // The same team-wide lock as the offer (reach.ts): the cap counts exactly.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.skill_offer:${teamId}`}, 0))`,
    );
    const current = await tx.execute<{ slug: string; access: SkillAccess }>(sql`
      SELECT slug,
        CASE WHEN offer_to_all AND access = 'available' THEN 'default_on' ELSE access::text END
          AS access
      FROM team_skills
      WHERE team_id = ${teamId} AND id = ${skillId} AND archived_at IS NULL FOR UPDATE`);
    const skill = current.rows[0];
    // Archived skills are hidden from new use (SK33): their access mode is not changed.
    if (!skill) return { ok: false, code: "not_found" };
    if (input.onlyFrom && !input.onlyFrom.includes(skill.access))
      return { ok: false, code: "forbidden" };
    if ((access === "required" || skill.access === "required") && !input.mayRequire)
      return { ok: false, code: "forbidden" };
    const loadsForAll = (a: SkillAccess) => a === "default_on" || a === "required";
    if (loadsForAll(access) && !loadsForAll(skill.access)) {
      const { rows } = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::integer AS n FROM team_skills
        WHERE team_id = ${teamId} AND archived_at IS NULL
          AND (access IN ('default_on', 'required') OR offer_to_all)`);
      if (Number(rows[0]?.n ?? 0) >= MAX_OFFERED_SKILLS) return { ok: false, code: "offer_limit" };
    }
    await tx.execute(sql`
      UPDATE team_skills SET access = ${access}::skill_access,
        offer_to_all = ${access === "default_on"}, updated_at = now()
      WHERE team_id = ${teamId} AND id = ${skillId}`);
    if (skill.access !== access) {
      await recordAudit(tx, {
        action: "skill.access.changed",
        teamId,
        target: { skillId, slug: skill.slug, access, previous: skill.access },
      });
      if (input.offerAudit)
        await recordAudit(tx, {
          action: "skill.offer.changed",
          teamId,
          target: { skillId, slug: skill.slug, offerToAll: access === "default_on" },
        });
    }
    const n = await requiredCount(tx, teamId);
    return {
      ok: true,
      access,
      requiredCount: n,
      ...(n >= REQUIRED_WARN_AT ? { warning: "many_required" as const } : {}),
    };
  });
}
