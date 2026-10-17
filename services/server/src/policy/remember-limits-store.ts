import {
  CLOSED_REMEMBER_LIMITS,
  DEFAULT_REMEMBER_LIMITS,
  looserThanFloor,
  rememberLimitsSchema,
  tightenRememberLimits,
  type RememberLimits,
} from "@kobe/protocol";
import { siteSettings, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Admin limits on remembered approvals (KOBE-289 ac-5). The site floor's are in `site_settings`
 * (one key, JSON text); a team's in `teams.settings` (key `remember_limits`, no migration). A team's
 * effective limits are both, tightened field by field: a team can never loosen the floor. A value
 * that fails the schema reads as "nothing may be remembered" (fail closed); no value at all as the
 * defaults (everything, as before KOBE-289).
 */
export const SITE_REMEMBER_LIMITS_KEY = "policy.remember_limits";
export const TEAM_REMEMBER_LIMITS_SETTING = "remember_limits";

function parseStored(raw: unknown): RememberLimits {
  if (raw === null || raw === undefined) return DEFAULT_REMEMBER_LIMITS;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return CLOSED_REMEMBER_LIMITS;
    }
  }
  const parsed = rememberLimitsSchema.safeParse(value);
  return parsed.success ? parsed.data : CLOSED_REMEMBER_LIMITS;
}

export interface TeamRememberLimits {
  /** The site floor's limits. */
  readonly site: RememberLimits;
  /** What the team stored (defaults when none). */
  readonly team: RememberLimits;
  /** What applies to the team's members: both, tightened. */
  readonly effective: RememberLimits;
}

/** The floor and a team's limits in one statement (site_settings and teams are site tables). */
export async function readTeamRememberLimits(
  db: KobeDb | KobeTx,
  teamId: string,
): Promise<TeamRememberLimits> {
  const res = await db.execute<{ site: string | null; team: unknown }>(sql`
    SELECT (SELECT value FROM site_settings WHERE key = ${SITE_REMEMBER_LIMITS_KEY}) AS site,
           (SELECT CASE WHEN jsonb_typeof(settings) = 'object'
                        THEN settings -> ${TEAM_REMEMBER_LIMITS_SETTING} END
              FROM teams WHERE id = ${teamId}) AS team`);
  const row = res.rows[0];
  const site = parseStored(row?.site ?? null);
  const team = parseStored(row?.team ?? null);
  return { site, team, effective: tightenRememberLimits(site, team) };
}

export async function readSiteRememberLimits(db: KobeDb): Promise<RememberLimits> {
  const res = await db.execute<{ value: string }>(sql`
    SELECT value FROM site_settings WHERE key = ${SITE_REMEMBER_LIMITS_KEY}`);
  return parseStored(res.rows[0]?.value ?? null);
}

/** Saves the site floor's limits, audited (`policy.remember_limits.updated`, scope site). */
export async function writeSiteRememberLimits(db: KobeDb, limits: RememberLimits): Promise<void> {
  const text = JSON.stringify(limits);
  await db.transaction(async (tx) => {
    await tx
      .insert(siteSettings)
      .values({ key: SITE_REMEMBER_LIMITS_KEY, value: text })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { value: text, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      action: "policy.remember_limits.updated",
      target: auditTarget("site", limits),
    });
  });
}

export type TeamLimitsResult =
  | { readonly ok: true; readonly limits: TeamRememberLimits }
  | { readonly ok: false; readonly looser: readonly string[] };

/**
 * Saves a team's limits, audited. Refused (`looser` names the fields) when they are looser than
 * the site floor in force: a team can only tighten it. The read of the floor and the write share
 * the transaction; the team row is locked so two saves don't interleave.
 */
export async function writeTeamRememberLimits(
  db: KobeDb,
  teamId: string,
  limits: RememberLimits,
): Promise<TeamLimitsResult> {
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(sql`SELECT 1 FROM teams WHERE id = ${teamId} FOR NO KEY UPDATE`);
    const current = await readTeamRememberLimits(tx, teamId);
    const looser = looserThanFloor(limits, current.site);
    if (looser.length > 0) return { ok: false, looser };
    await tx.execute(sql`
      UPDATE teams
         SET settings = jsonb_set(
               CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
               ${`{${TEAM_REMEMBER_LIMITS_SETTING}}`}::text[], ${JSON.stringify(limits)}::jsonb)
       WHERE id = ${teamId}`);
    await recordAudit(tx, {
      action: "policy.remember_limits.updated",
      teamId,
      target: auditTarget("team", limits),
    });
    return {
      ok: true,
      limits: {
        site: current.site,
        team: limits,
        effective: tightenRememberLimits(current.site, limits),
      },
    };
  });
}

function auditTarget(scope: "site" | "team", limits: RememberLimits) {
  return {
    scope,
    scopes: [...limits.scopes],
    maxDurationSeconds: limits.max_duration_seconds,
    mcpTools: limits.mcp_tools,
    exactOnly: limits.exact_only,
    approveAll: limits.approve_all,
  };
}
