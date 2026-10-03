import { createHash, randomUUID } from "node:crypto";
import {
  APPROVAL_MODES,
  canonicalJson,
  toolInputSchema,
  type JsonObject,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyInput,
  type PolicyReasonCode,
  type RiskClass,
} from "@kobe/protocol";
import { sql, withTeam, type ConnectorAuthKind, type KobeDb, type PinnedTool } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import { clampApprovalMode } from "../sandbox-wire/policy-check.js";
import type { RunPolicyContextSource } from "../sandbox-wire/types.js";
import type { McpApprovalFailure, McpApprovalVerifier } from "./approvals.js";
import { describePinnedTool, loadTeamConnector, type TeamConnector } from "./catalog.js";

/**
 * The MCP proxy's policy re-check (D27, D29 "MCP calls are enforced a second time at the MCP
 * proxy"). The proxy asks before every upstream `tools/call`; the server decides from its own
 * state only — the sandbox supplies a connector id, a tool name, the input and (as claims it must
 * prove) the thread and, optionally, the tool call id:
 *
 * 1. the connector must be enabled in the token's team and the tool must be in its pinned
 *    snapshot (`unknown_tool` otherwise; drift and exposure are the engine's gates);
 * 2. the thread must be the token user's, with an active run leased to the token's sandbox;
 * 3. the policy engine (KOBE-35) decides with `enforcement_point: "mcp_proxy"` and the team's
 *    exposure, the run's clamped approval mode, its trigger and agent tool lists;
 * 4. `require_approval` → a signed approval for exactly this run, tool and input must verify and
 *    be consumed ({@link McpApprovalVerifier}); anything else is a deny;
 * 5. the decision is audited (`mcp.tool_call`); an allowed call whose audit row cannot be written
 *    is refused. Every error is a deny.
 */

export interface McpPrincipal {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
}

export interface McpCallRequest {
  readonly connectorId: string;
  /** The upstream MCP tool name (`tools/call` `params.name`). */
  readonly tool: string;
  readonly arguments: unknown;
  /** The thread whose Pi process makes the call (per-session header, KOBE-62). */
  readonly threadId?: string;
  /** `_meta["kobe.dev/tool_call_id"]` when the client sends one. */
  readonly toolCallId?: string;
}

export interface McpUpstreamTarget {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly auth_kind: ConnectorAuthKind;
}

export type McpCallDecision =
  | {
      readonly decision: "allow";
      readonly connector: McpUpstreamTarget;
      readonly tool: { readonly name: string; readonly pi_name: string };
      /** SHA-256 (hex) of `canonicalJson(input)`: the proxy forwards exactly these bytes. */
      readonly input_sha256: string;
      readonly reason: PolicyReasonCode;
      readonly approval_id?: string;
    }
  | {
      readonly decision: "deny";
      readonly code: PolicyReasonCode;
      readonly message: string;
      readonly approval_failure?: McpApprovalFailure;
    };

export interface McpDecideDeps {
  readonly db: KobeDb;
  readonly engine: PolicyEngine;
  readonly runContext: RunPolicyContextSource;
  readonly approvals: McpApprovalVerifier;
  readonly now?: () => Date;
  /** Whether a denied call of this sandbox may be audited now (per-sandbox throttle). */
  readonly mayAuditDenied?: (sandboxId: string) => boolean;
}

/** Same grammar as the `mcp.tool_call` audit field: other ids are decided on but not recorded. */
const PLAIN_ID = /^[A-Za-z0-9_.:/-]{1,128}$/;

export function inputDigest(input: JsonObject): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function deny(
  code: PolicyReasonCode,
  message: string,
  approvalFailure?: McpApprovalFailure,
): Extract<McpCallDecision, { decision: "deny" }> {
  return {
    decision: "deny",
    code,
    message: message.slice(0, 1000),
    ...(approvalFailure === undefined ? {} : { approval_failure: approvalFailure }),
  };
}

interface ActiveRun {
  readonly runId: string;
  readonly threadId: string;
  readonly trigger: "user" | "schedule";
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  readonly projectId: string | null;
}

/** The thread's active run, owned by the token's user and leased to the token's sandbox. */
async function loadActiveRun(
  deps: McpDecideDeps,
  principal: McpPrincipal,
  threadId: string,
): Promise<
  | {
      run: ActiveRun;
      mode: PolicyInput["run"]["approval_mode"];
      toolsAllow: string[];
      toolsDeny: string[];
      projectId?: string;
    }
  | undefined
> {
  return withTeam(deps.db, principal.teamId, async (tx) => {
    const res = await tx.execute<{
      run_id: string;
      thread_id: string;
      trigger: "user" | "schedule";
      agent_id: string | null;
      agent_version: number | null;
      project_id: string | null;
    }>(sql`
      SELECT r.id AS run_id, t.id AS thread_id, r.trigger, t.agent_id, t.agent_version, t.project_id
        FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
        JOIN sandbox_run_leases l ON l.team_id = r.team_id AND l.run_id = r.id
       WHERE r.team_id = ${principal.teamId} AND t.team_id = ${principal.teamId}
         AND r.thread_id = ${threadId}
         AND r.status IN ('running', 'waiting_approval')
         AND t.owner_user_id = ${principal.userId}
         AND l.user_id = ${principal.userId} AND l.sandbox_id = ${principal.sandboxId}
       ORDER BY r.created_at DESC
       LIMIT 1`);
    const row = res.rows[0];
    if (!row) return undefined;
    const run: ActiveRun = {
      runId: row.run_id,
      threadId: row.thread_id,
      trigger: row.trigger,
      agentId: row.agent_id,
      agentVersion: row.agent_version,
      projectId: row.project_id,
    };
    const context = await deps.runContext.load(tx, {
      teamId: principal.teamId,
      runId: run.runId,
      threadId: run.threadId,
    });
    if (!APPROVAL_MODES.includes(context.floor)) throw new Error("approval floor unavailable");
    // As the wire's policy.check: scheduled runs are auto (D32), everything clamped to the floor.
    const requested =
      run.trigger === "schedule" ? "auto" : (context.approvalMode ?? "ask-on-write");
    const mode = clampApprovalMode(
      APPROVAL_MODES.includes(requested) ? requested : "ask-on-write",
      context.floor,
    );
    const projectId = context.projectId ?? run.projectId ?? undefined;
    return {
      run,
      mode,
      toolsAllow: [...(context.toolsAllow ?? [])],
      toolsDeny: [...(context.toolsDeny ?? [])],
      ...(projectId === undefined ? {} : { projectId }),
    };
  });
}

interface AuditFacts {
  readonly connectorId: string;
  readonly piName: string;
  readonly runId?: string;
  readonly threadId?: string;
  readonly toolCallId?: string;
  readonly risk?: RiskClass;
}

async function audit(
  deps: McpDecideDeps,
  principal: McpPrincipal,
  facts: AuditFacts,
  outcome:
    | { decision: "allowed"; reason: PolicyReasonCode; approvalId?: string }
    | { decision: "denied"; reason: PolicyReasonCode; approvalFailure?: McpApprovalFailure },
): Promise<void> {
  await withTeam(deps.db, principal.teamId, (tx) =>
    recordAudit(tx, {
      action: "mcp.tool_call",
      teamId: principal.teamId,
      actor: { kind: "user", id: principal.userId },
      target: {
        sandboxId: principal.sandboxId,
        userId: principal.userId,
        connectorId: facts.connectorId,
        tool: facts.piName,
        ...(facts.runId === undefined ? {} : { runId: facts.runId }),
        ...(facts.threadId === undefined ? {} : { threadId: facts.threadId }),
        ...(facts.toolCallId !== undefined && PLAIN_ID.test(facts.toolCallId)
          ? { toolCallId: facts.toolCallId }
          : {}),
        ...(facts.risk === undefined ? {} : { risk: facts.risk }),
        decision: outcome.decision,
        reason: outcome.reason,
        ...("approvalId" in outcome && outcome.approvalId !== undefined
          ? { approvalId: outcome.approvalId }
          : {}),
        ...("approvalFailure" in outcome && outcome.approvalFailure !== undefined
          ? { approvalFailure: outcome.approvalFailure }
          : {}),
      },
    }),
  );
}

/** Pi's name for an unpinned upstream tool (audit only): same sanitising as Pi 1.0.0. */
function fallbackPiName(connector: TeamConnector, tool: string): string {
  const segment = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
  return `mcp__${segment(connector.name)}__${segment(tool) || "_"}`.slice(0, 256);
}

/** Decides one call; never throws (every failure is a deny). */
export async function decideMcpCall(
  deps: McpDecideDeps,
  principal: McpPrincipal,
  request: McpCallRequest,
): Promise<McpCallDecision> {
  const now = deps.now ?? (() => new Date());
  const mayAuditDenied = deps.mayAuditDenied ?? (() => true);
  let facts: AuditFacts | undefined;

  const denied = async (
    code: PolicyReasonCode,
    message: string,
    approvalFailure?: McpApprovalFailure,
  ): Promise<McpCallDecision> => {
    if (facts && mayAuditDenied(principal.sandboxId)) {
      try {
        await audit(deps, principal, facts, {
          decision: "denied",
          reason: code,
          ...(approvalFailure === undefined ? {} : { approvalFailure }),
        });
      } catch (err) {
        logger.error({ err, code }, "mcp: denied call could not be audited");
      }
    }
    logger.info(
      { sandboxId: principal.sandboxId, teamId: principal.teamId, code, approvalFailure },
      "mcp call denied",
    );
    return deny(code, message, approvalFailure);
  };

  try {
    const connector = await loadTeamConnector(deps.db, principal.teamId, request.connectorId);
    if (!connector) {
      return await denied("connector_not_enabled", "This connector is not enabled in your team.");
    }
    const pinned: PinnedTool | undefined = connector.tools.find((t) => t.name === request.tool);
    facts = {
      connectorId: connector.id,
      piName: pinned?.pi_name ?? fallbackPiName(connector, request.tool),
      ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
      ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    };
    if (!pinned) {
      return await denied(
        "unknown_tool",
        `${request.tool.slice(0, 128)} is not a pinned tool of this connector.`,
      );
    }
    const descriptor = describePinnedTool(connector.id, pinned);
    facts = { ...facts, risk: descriptor.risk };

    const input = toolInputSchema.safeParse(request.arguments ?? {});
    if (!input.success) {
      return await denied("invalid_input", "The tool input is not valid, so the call was denied.");
    }
    if (request.threadId === undefined) {
      return await denied("run_not_active", "The call names no thread, so it was denied.");
    }
    const active = await loadActiveRun(deps, principal, request.threadId);
    if (!active) {
      return await denied("run_not_active", "No active run of this thread runs in this sandbox.");
    }
    facts = { ...facts, runId: active.run.runId };

    const policyInput: PolicyInput = {
      actor: { user_id: principal.userId, kind: active.run.trigger },
      team_id: principal.teamId,
      agent: {
        agent_id: active.run.agentId,
        version: active.run.agentVersion,
        tools_allow: active.toolsAllow,
        tools_deny: active.toolsDeny,
      },
      run: { run_id: active.run.runId, thread_id: active.run.threadId, approval_mode: active.mode },
      tool: descriptor,
      tool_call_id: request.toolCallId ?? `mcp-proxy-${randomUUID()}`,
      input: input.data,
      context: {
        enforcement_point: "mcp_proxy",
        connector_exposure: connector.exposure,
        ...(active.projectId === undefined ? {} : { project_id: active.projectId }),
      },
    };
    const decision: PolicyDecision = await deps.engine.decide(policyInput);
    const first = decision.reasons[0];
    if (decision.effect === "deny") {
      return await denied(first?.code ?? "policy_error", first?.message ?? "Denied by policy.");
    }

    let reason: PolicyReasonCode = first?.code ?? "default_prompt";
    let approvalId: string | undefined;
    if (decision.effect === "require_approval") {
      const approved = await deps.approvals.authorize({
        teamId: principal.teamId,
        userId: principal.userId,
        runId: active.run.runId,
        tool: pinned.pi_name,
        ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
        input: input.data,
        now: now(),
      });
      if (!approved.ok) {
        return await denied(
          reason,
          "This call needs your approval and no valid signed approval exists for it, so it was denied.",
          approved.reason,
        );
      }
      reason = "approval_granted";
      approvalId = approved.approvalId;
    }

    // The record of the call comes first: no audit row, no upstream call.
    await audit(deps, principal, facts, {
      decision: "allowed",
      reason,
      ...(approvalId === undefined ? {} : { approvalId }),
    });
    return {
      decision: "allow",
      connector: {
        id: connector.id,
        name: connector.name,
        url: connector.url,
        auth_kind: connector.authKind,
      },
      tool: { name: pinned.name, pi_name: pinned.pi_name },
      input_sha256: inputDigest(input.data),
      reason,
      ...(approvalId === undefined ? {} : { approval_id: approvalId }),
    };
  } catch (err) {
    logger.error(
      { err, sandboxId: principal.sandboxId },
      "mcp: call could not be decided (denied)",
    );
    return deny(
      "policy_error",
      "Policy could not be evaluated, so the call was denied. Try again.",
    );
  }
}
