import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * A member's own skill choices in one team (KOBE-316, SK25, SK27, D22), as rows of
 * `member_skill_enablements` (no row = the default):
 * - **personal:** each of their personal skills is on by default in every team; turning one off
 *   leaves it out of their runs in this team only (and out of the team's review queue).
 * - **team:** a team skill On by default can be turned off, an Available one on. Required and
 *   Hidden skills are not the member's to toggle; archived ones are not offered.
 * - **catalog:** the same for the team's installs (not a member add: that has its own version; a
 *   toggle of an installed skill clears an add left from before the install, KOBE-338 review L4).
 * Every real change is audited in the team (names and ids only).
 */
export type EnablementKind = "personal" | "team" | "catalog";
type Access = "available" | "default_on" | "required" | "hidden";

export interface PersonalChoice {
  readonly skillId: string;
  readonly name: string;
  readonly enabled: boolean;
}

export interface TeamChoice extends PersonalChoice {
  readonly access: Access;
}

export interface SkillChoices {
  readonly personal: readonly PersonalChoice[];
  readonly team: readonly TeamChoice[];
  readonly catalog: readonly TeamChoice[];
}

/** On for this member: Required always, On by default unless turned off, others if turned on. */
const effective = (access: Access, mine: boolean | null) =>
  access === "required" || (access === "default_on" ? mine !== false : mine === true);

export function listSkillChoices(
  db: KobeDb,
  teamId: string,
  userId: string,
): Promise<SkillChoices> {
  return withTeam(db, teamId, async (tx) => {
    const personal = await tx.execute<{ id: string; slug: string; mine: boolean | null }>(sql`
      SELECT p.id, p.slug, e.enabled AS mine FROM personal_skills p
      LEFT JOIN member_skill_enablements e ON e.team_id = ${teamId} AND e.user_id = ${userId}
        AND e.personal_skill_id = p.id
      WHERE p.owner_user_id = ${userId}
      ORDER BY p.slug`);
    // "Offer to all agents" written alone (a rollback across KOBE-308) reads as On by default.
    const team = await tx.execute<{
      id: string;
      slug: string;
      access: Access;
      mine: boolean | null;
    }>(
      sql`
      SELECT s.id, s.slug, e.enabled AS mine,
        CASE WHEN s.offer_to_all AND s.access = 'available' THEN 'default_on' ELSE s.access::text END
          AS access
      FROM team_skills s
      LEFT JOIN member_skill_enablements e ON e.team_id = s.team_id AND e.user_id = ${userId}
        AND e.team_skill_id = s.id
      WHERE s.team_id = ${teamId} AND s.archived_at IS NULL AND s.access <> 'hidden'
      ORDER BY s.slug`,
    );
    const catalog = await tx.execute<{
      id: string;
      name: string;
      access: Access;
      mine: boolean | null;
    }>(
      sql`
      SELECT i.skill_id AS id, r.name, i.access::text AS access, e.enabled AS mine
      FROM team_skill_installs i JOIN registry_skills r ON r.id = i.skill_id
      LEFT JOIN member_skill_enablements e ON e.team_id = i.team_id AND e.user_id = ${userId}
        AND e.catalog_skill_id = i.skill_id AND e.version_id IS NULL
      WHERE i.team_id = ${teamId} AND i.access <> 'hidden'
        AND NOT EXISTS (SELECT 1 FROM team_skill_blocks b
          WHERE b.team_id = i.team_id AND b.skill_id = i.skill_id)
      ORDER BY r.name`,
    );
    return {
      personal: personal.rows.map((r) => ({
        skillId: r.id,
        name: r.slug,
        enabled: r.mine !== false,
      })),
      team: team.rows.map((r) => ({
        skillId: r.id,
        name: r.slug,
        access: r.access,
        enabled: effective(r.access, r.mine),
      })),
      catalog: catalog.rows.map((r) => ({
        skillId: r.id,
        name: r.name,
        access: r.access,
        enabled: effective(r.access, r.mine),
      })),
    };
  });
}

export type EnablementResult =
  | { readonly ok: true; readonly enabled: boolean }
  | { readonly ok: false; readonly code: "not_found" | "not_toggleable" };

/** The skill's name and access for a toggle, or null when it isn't this member's to see. */
async function target(
  tx: KobeTx,
  input: { teamId: string; userId: string; kind: EnablementKind; skillId: string },
): Promise<{ name: string; access: Access | null } | null> {
  const { teamId, userId, skillId } = input;
  const q =
    input.kind === "personal"
      ? sql`SELECT slug AS name, NULL AS access FROM personal_skills
            WHERE id = ${skillId} AND owner_user_id = ${userId}`
      : input.kind === "team"
        ? sql`SELECT slug AS name,
                CASE WHEN offer_to_all AND access = 'available' THEN 'default_on'
                  ELSE access::text END AS access
              FROM team_skills
              WHERE team_id = ${teamId} AND id = ${skillId} AND archived_at IS NULL`
        : sql`SELECT r.name, i.access::text AS access
              FROM team_skill_installs i JOIN registry_skills r ON r.id = i.skill_id
              WHERE i.team_id = ${teamId} AND i.skill_id = ${skillId}
                AND NOT EXISTS (SELECT 1 FROM team_skill_blocks b
                  WHERE b.team_id = i.team_id AND b.skill_id = i.skill_id)`;
  const { rows } = await tx.execute<{ name: string; access: Access | null }>(q);
  return rows[0] ?? null;
}

const COLUMN = {
  personal: "personal_skill_id",
  team: "team_skill_id",
  catalog: "catalog_skill_id",
};

/** Turns one skill on or off for the member in the team; audits a real change. */
export function setEnablement(
  db: KobeDb,
  input: {
    readonly teamId: string;
    readonly userId: string;
    readonly kind: EnablementKind;
    readonly skillId: string;
    readonly enabled: boolean;
  },
): Promise<EnablementResult> {
  const { teamId, userId, kind, skillId, enabled } = input;
  return withTeam(db, teamId, async (tx): Promise<EnablementResult> => {
    // One member's toggles one at a time: the first row is inserted once, and audited once.
    const key = `kobe.skills.enablement:${teamId}:${userId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const skill = await target(tx, input);
    if (!skill) return { ok: false, code: "not_found" };
    if (skill.access === "required" || skill.access === "hidden")
      return { ok: false, code: "not_toggleable" };
    const column = sql.identifier(COLUMN[kind]);
    const before = await tx.execute<{ enabled: boolean }>(sql`
      SELECT enabled FROM member_skill_enablements
      WHERE team_id = ${teamId} AND user_id = ${userId} AND ${column} = ${skillId}
      FOR UPDATE`);
    const was = before.rows[0]?.enabled;
    const wasOn = skill.access === null ? was !== false : effective(skill.access, was ?? null);
    if (before.rows.length > 0)
      await tx.execute(sql`
        UPDATE member_skill_enablements SET enabled = ${enabled}, updated_at = now(),
          version_id = NULL, pin_mode = NULL
        WHERE team_id = ${teamId} AND user_id = ${userId} AND ${column} = ${skillId}`);
    else
      await tx.execute(sql`
        INSERT INTO member_skill_enablements (team_id, user_id, ${column}, enabled)
        VALUES (${teamId}, ${userId}, ${skillId}, ${enabled})
        ON CONFLICT DO NOTHING`);
    if (wasOn !== enabled)
      await recordAudit(tx, {
        action: "skill.enablement.changed",
        teamId,
        target: { kind, skillId, name: skill.name, enabled },
      });
    return { ok: true, enabled };
  });
}
