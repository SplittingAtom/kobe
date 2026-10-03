import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  toolInputSchema,
  type JsonObject,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyInput,
  type PolicyReason,
  type PolicyReasonCode,
  type RiskClass,
  type ToolDescriptor,
} from "@kobe/protocol";
import { withTeam, type ConnectorAuthKind, type KobeDb, type PinnedTool } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import type { RunPolicyContextSource } from "../sandbox-wire/types.js";
import type { McpApprovalFailure, McpApprovalVerifier } from "./approvals.js";
import { describePinnedTool, loadTeamConnector, type TeamConnector } from "./catalog.js";
import { loadActiveRuns, type ActiveRunContext } from "./run-context.js";

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
 *    exposure under **every** active run of the user leased to that sandbox (each with its own
 *    clamped mode, trigger and agent tool lists), combined by `combineDecisions`: the sandbox's
 *    thread claim selects whose approval may authorise, never which policy applies (review M1);
 * 4. needing approval → a signed approval for exactly the named run, tool and input must verify
 *    and be consumed ({@link McpApprovalVerifier}); anything else is a deny;
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

function policyInputFor(
  principal: McpPrincipal,
  run: ActiveRunContext,
  tool: ToolDescriptor,
  toolCallId: string,
  input: JsonObject,
  connector: TeamConnector,
): PolicyInput {
  return {
    actor: { user_id: principal.userId, kind: run.trigger },
    team_id: principal.teamId,
    agent: {
      agent_id: run.agentId,
      version: run.agentVersion,
      tools_allow: run.toolsAllow,
      tools_deny: run.toolsDeny,
    },
    run: { run_id: run.runId, thread_id: run.threadId, approval_mode: run.mode },
    tool,
    tool_call_id: toolCallId,
    input,
    context: {
      enforcement_point: "mcp_proxy",
      connector_exposure: connector.exposure,
      ...(run.projectId === undefined ? {} : { project_id: run.projectId }),
    },
  };
}

type Combined =
  | { readonly effect: "allow" | "require_approval"; readonly reason: PolicyReason }
  | { readonly effect: "deny"; readonly reason: PolicyReason };

const POLICY_ERROR: PolicyReason = {
  code: "policy_error",
  stage: "install_deny",
  message: "Policy could not be evaluated, so the call was denied.",
};

/**
 * One decision for a call that may come from any of the sandbox's active runs (review M1):
 * - the named run denies → deny (its own policy forbids it, approval or not);
 * - every run allows → allow (no run's policy asks for more);
 * - otherwise (the named run asks, or a sibling run asks or denies) → the user's signed approval
 *   of exactly this input in the named run is required. That approval is the user's consent to
 *   this exact call, whichever of their processes runs it; without one, a laxer sibling (a
 *   scheduled `auto` run, a broader allow list) can never stand in for the run that asks.
 */
export function combineDecisions(
  named: PolicyDecision,
  siblings: readonly PolicyDecision[],
): Combined {
  const first = (d: PolicyDecision) => d.reasons[0] ?? POLICY_ERROR;
  if (named.effect === "deny") return { effect: "deny", reason: first(named) };
  const strict = siblings.find((d) => d.effect !== "allow");
  if (named.effect === "allow" && strict === undefined)
    return { effect: "allow", reason: first(named) };
  return {
    effect: "require_approval",
    reason: named.effect === "require_approval" ? first(named) : first(strict ?? named),
  };
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
    const loaded = await loadActiveRuns(deps.db, deps.runContext, principal);
    if (!loaded.ok) {
      return await denied("run_not_active", "Too many active runs in this sandbox; try again.");
    }
    // The run whose thread the sandbox named: its approvals are the ones that can authorise.
    const named = loaded.runs.find((r) => r.threadId === request.threadId);
    if (!named) {
      return await denied("run_not_active", "No active run of this thread runs in this sandbox.");
    }
    facts = { ...facts, runId: named.runId };

    const toolCallId = request.toolCallId ?? `mcp-proxy-${randomUUID()}`;
    const decide = (run: ActiveRunContext) =>
      deps.engine.decide(
        policyInputFor(principal, run, descriptor, toolCallId, input.data, connector),
      );
    // The sandbox's claim picks the named run, but cannot pick its policy: the call is decided
    // under every active run it could belong to (review M1). See `combineDecisions`.
    const namedDecision = await decide(named);
    const siblings = await Promise.all(loaded.runs.filter((r) => r !== named).map(decide));
    const combined = combineDecisions(namedDecision, siblings);
    if (combined.effect === "deny") {
      return await denied(combined.reason.code, combined.reason.message);
    }

    let reason: PolicyReasonCode = combined.reason.code;
    let approvalId: string | undefined;
    if (combined.effect === "require_approval") {
      const approved = await deps.approvals.authorize({
        teamId: principal.teamId,
        userId: principal.userId,
        runId: named.runId,
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
