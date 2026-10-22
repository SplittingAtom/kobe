import type { PolicyDecision, PolicyReason } from "@kobe/protocol";
import { sql, withTeam, type KobeDb, type KobeTx, type TeamRole } from "@kobe/db";
import { toolManifestSchema, withSiteNames, type ToolManifest } from "../agents/manifest.js";
import { recordAudit } from "../audit/record.js";
import type { SiteRole } from "../authz/permissions.js";

/**
 * Dangerous mode (AC1, docs/specs/agent-creator.md, approved by Chris 2026-10-22): an admin's
 * agent whose allowed tools run without an approval card. Three server-side pieces live here:
 *
 * - who may set it ({@link mayUseDangerousMode}: site Owner/Admin, or the active team's admin);
 * - whether it applies to a run's calls ({@link loadRunDangerousMode}, read per call);
 * - the audit row for each call it allowed ({@link recordDangerousApplied}).
 *
 * The policy engine (`evaluate.ts`) turns the flag into an outcome after every deny stage and
 * every ask rule; nothing here decides a call.
 */

/** Only site admins (and the Owner) and team admins may set, keep or publish Dangerous mode. */
export function mayUseDangerousMode(teamRole: TeamRole | null, siteRole: SiteRole): boolean {
  return siteRole === "owner" || siteRole === "admin" || teamRole === "team_admin";
}

/** The refusal for anyone else (403); the message names the field. */
export const DANGEROUS_FORBIDDEN = {
  code: "dangerous_mode_forbidden",
  message:
    "Only site and team admins can use the Dangerous approval mode. Choose another approval mode.",
} as const;

interface RunAgentRow {
  readonly agent_scope: "team" | "personal" | "gallery" | null;
  readonly agent_id: string | null;
  readonly agent_version: number | null;
  readonly owner_user_id: string;
  readonly trigger: string;
  readonly skill_eval: boolean;
}

/** A Dangerous run's agent tool lists, which the policy input must then carry. */
export interface DangerousRun {
  readonly toolsAllow: readonly string[];
  readonly toolsDeny: readonly string[];
}

/**
 * Whether the run's agent is in Dangerous mode for this call, read inside the run's team
 * transaction: its frozen `tools.allow` / `tools.deny` when it is, else null. Only when all hold:
 *
 * - an interactive, non-eval run whose agent version is published (`runs.agent_version`: a draft's
 *   test chat asks as usual) and whose frozen manifest says `dangerous` (a version only an admin
 *   could publish);
 * - for a personal agent, its user is a site admin or this team's admin right now (it follows the
 *   user into every team, so the role is checked where it runs).
 *
 * The caller also requires an `auto` site floor. Anything unreadable is null (fail closed). The
 * tool lists come back with it because the engine's agent tool gate (`checkAgentTools`) must see
 * them before Dangerous mode may allow anything: denied tools stay denied.
 */
export async function loadRunDangerousMode(
  tx: KobeTx,
  run: { readonly teamId: string; readonly runId: string },
): Promise<DangerousRun | null> {
  const res = await tx.execute<RunAgentRow & Record<string, unknown>>(sql`
    SELECT t.agent_scope, t.agent_id, r.agent_version, t.owner_user_id, r.trigger, t.skill_eval
      FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${run.teamId} AND r.id = ${run.runId}`);
  const row = res.rows[0];
  if (!row || row.trigger !== "user" || row.skill_eval) return null;
  if (row.agent_scope === null || row.agent_id === null || row.agent_version === null) {
    return null;
  }
  const manifest = await dangerousManifest(tx, {
    teamId: run.teamId,
    scope: row.agent_scope,
    agentId: row.agent_id,
    version: row.agent_version,
  });
  if (manifest === null) return null;
  if (row.agent_scope === "personal" && !(await userIsAdminIn(tx, run.teamId, row.owner_user_id))) {
    return null;
  }
  return { toolsAllow: manifest.tools_allow, toolsDeny: manifest.tools_deny };
}

/** A published version's manifest when it is in Dangerous mode, else null (unreadable: null). */
async function dangerousManifest(
  tx: KobeTx,
  pin: {
    readonly teamId: string;
    readonly scope: "team" | "personal" | "gallery";
    readonly agentId: string;
    readonly version: number;
  },
): Promise<ToolManifest | null> {
  const res =
    pin.scope === "team"
      ? await tx.execute<{ tool_manifest: unknown }>(sql`
          SELECT tool_manifest FROM team_agent_versions
           WHERE team_id = ${pin.teamId} AND agent_id = ${pin.agentId}
             AND version = ${pin.version}`)
      : await tx.execute<{ tool_manifest: unknown }>(sql`
          SELECT tool_manifest FROM site_agent_versions
           WHERE agent_id = ${pin.agentId} AND version = ${pin.version}`);
  const parsed = toolManifestSchema.safeParse(withSiteNames(res.rows[0]?.tool_manifest));
  return parsed.success && parsed.data.approval_mode.dangerous === true ? parsed.data : null;
}

/**
 * Whether a thread's pinned version is in Dangerous mode (the chat's badge, AC1). Display only:
 * whether a call runs under it is `loadRunDangerousMode`'s, per call.
 */
export async function pinnedVersionIsDangerous(
  tx: KobeTx,
  pin: {
    readonly teamId: string;
    readonly scope: "team" | "personal" | "gallery" | null;
    readonly agentId: string | null;
    readonly version: number | null;
  },
): Promise<boolean> {
  const { scope, agentId, version } = pin;
  if (scope === null || agentId === null || version === null) return false;
  return (await dangerousManifest(tx, { teamId: pin.teamId, scope, agentId, version })) !== null;
}

async function userIsAdminIn(tx: KobeTx, teamId: string, userId: string): Promise<boolean> {
  const res = await tx.execute<{ team_role: TeamRole | null; site_role: SiteRole }>(sql`
    SELECT (SELECT role FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId})
             AS team_role,
           (SELECT role FROM site_roles WHERE user_id = ${userId}) AS site_role`);
  const row = res.rows[0];
  return row !== undefined && mayUseDangerousMode(row.team_role, row.site_role);
}

/** The reason Dangerous mode allowed this decision, if it did. */
export function appliedDangerousMode(decision: PolicyDecision): PolicyReason | undefined {
  if (decision.effect !== "allow") return undefined;
  return decision.reasons.find((r) => r.code === "dangerous_mode");
}

export interface DangerousApplication {
  readonly teamId: string;
  /** The run's user (the audit row's actor). */
  readonly userId: string;
  readonly runId: string;
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  readonly toolCallId: string;
  readonly tool: string;
  readonly enforcementPoint: "sandbox" | "mcp_proxy";
}

/**
 * Records `policy.dangerous_mode.applied` before the call runs, one row per call and enforcement
 * point (no input). Throws on a failed write: the caller then denies the call (no audit row, no
 * call).
 */
export async function recordDangerousApplied(db: KobeDb, a: DangerousApplication): Promise<void> {
  await withTeam(db, a.teamId, (tx) =>
    recordAudit(tx, {
      action: "policy.dangerous_mode.applied",
      teamId: a.teamId,
      actor: { kind: "user", id: a.userId },
      target: {
        runId: a.runId,
        toolCallId: a.toolCallId,
        tool: a.tool,
        ...(a.agentId === null ? {} : { agentId: a.agentId }),
        ...(a.agentVersion === null ? {} : { agentVersion: a.agentVersion }),
        enforcementPoint: a.enforcementPoint,
      },
    }),
  );
}
