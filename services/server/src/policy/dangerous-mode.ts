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
 * - whether it applies to a run's calls (`run-agent-tools.ts`, read per call);
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
 * whether a call runs under it is `loadRunAgentTools`'s, per call.
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
