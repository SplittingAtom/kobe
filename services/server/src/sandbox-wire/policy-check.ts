import {
  APPROVAL_MODES,
  type ApprovalMode,
  type PolicyCheckFrame,
  type PolicyEngine,
  type PolicyInput,
  type PolicyReason,
  type PolicyResultFrame,
  type ToolRegistry,
} from "@kobe/protocol";
import { eq, getMembership, sql, users, withTeam, type KobeDb } from "@kobe/db";
import { appendRunEvents } from "../event-stream/append.js";
import type {
  ApprovalBroker,
  ApprovalOutcome,
  RunPolicyContextSource,
  SandboxTarget,
} from "./types.js";

/**
 * `policy.check` → the policy engine (D29, KOBE-35). The sandbox sends a tool name and an input,
 * nothing else; everything the decision depends on is the server's: the run and thread (under the
 * team's RLS, owned by this connection's user and still active), live membership and account,
 * the effective approval mode (clamped to the floor), and the tool descriptor (engine registry).
 * The engine is called outside any team transaction (it opens its own reads). `require_approval`
 * never reaches the sandbox: the {@link ApprovalBroker} resolves it (KOBE-37) while the sandbox
 * waits with `policy.pending`. Every failure is a deny (fail closed).
 */

const STRICTNESS: Record<ApprovalMode, number> = { auto: 0, "ask-on-write": 1, "ask-all": 2 };

/** The stricter of `mode` and `floor` (a run is never looser than the floor). */
export function clampApprovalMode(mode: ApprovalMode, floor: ApprovalMode): ApprovalMode {
  return STRICTNESS[mode] >= STRICTNESS[floor] ? mode : floor;
}

/**
 * The contract has no reason code for "the run is not active" or "the server could not check";
 * these denials use the first stage's code with an explanatory message (as KOBE-35 does for
 * internal errors). Flagged for a contracts PR.
 */
export function denyReason(message: string): PolicyReason {
  return { code: "install_deny_rule", stage: "install_deny", message };
}

type Deny = Extract<PolicyResultFrame, { decision: "deny" }>;
type Allow = Extract<PolicyResultFrame, { decision: "allow" }>;

export function denyFrame(
  frame: PolicyCheckFrame,
  reasons: readonly PolicyReason[],
  message: string,
): Deny {
  return {
    v: 1,
    type: "policy.result",
    request_id: frame.request_id,
    run_id: frame.run_id,
    tool_call_id: frame.tool_call_id,
    decision: "deny",
    reasons: reasons.length > 0 ? [...reasons] : [denyReason(message)],
    message: message.slice(0, 2000),
  };
}

/** Default broker until approvals exist (KOBE-37): deny, saying why. */
export const DENY_APPROVALS: ApprovalBroker = {
  request(request) {
    return Promise.resolve({
      decision: "deny",
      reasons: request.decision.reasons,
      message:
        "This tool call needs your approval, and approvals are not available yet, so it was denied.",
    } satisfies ApprovalOutcome);
  },
};

/** Default run context: mode from KOBE-30 when it exists, `ask-on-write` otherwise (D29 default). */
export const DEFAULT_RUN_CONTEXT: RunPolicyContextSource = { load: () => Promise.resolve({}) };

export interface PolicyCheckDeps {
  readonly db: KobeDb;
  readonly engine: PolicyEngine;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly runContext: RunPolicyContextSource;
}

async function accountActive(db: KobeDb, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, userId));
  return row !== undefined && row.deactivatedAt === null;
}

/** Builds the engine input from server state; a string is the reason to deny instead. */
async function buildInput(
  deps: PolicyCheckDeps,
  target: SandboxTarget,
  frame: PolicyCheckFrame,
): Promise<PolicyInput | string> {
  const loaded = await withTeam(deps.db, target.teamId, async (tx) => {
    const res = await tx.execute<{
      status: string;
      trigger: "user" | "schedule";
      thread_id: string;
      owner_user_id: string;
      agent_id: string | null;
      agent_version: number | null;
      project_id: string | null;
    }>(sql`
      SELECT r.status, r.trigger, r.thread_id, t.owner_user_id, t.agent_id, t.agent_version,
             t.project_id
        FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${target.teamId} AND r.id = ${frame.run_id}`);
    const row = res.rows[0];
    if (!row) return undefined;
    const context = await deps.runContext.load(tx, {
      teamId: target.teamId,
      runId: frame.run_id,
      threadId: row.thread_id,
    });
    return { row, context };
  });
  if (!loaded) return "The run was not found.";
  const { row, context } = loaded;
  if (row.owner_user_id !== target.userId || row.thread_id !== frame.thread_id) {
    return "The run does not belong to this sandbox.";
  }
  if (row.status !== "running" && row.status !== "waiting_approval") return "The run has ended.";
  if (!(await accountActive(deps.db, target.userId))) return "The account is deactivated.";
  if ((await getMembership(deps.db, target.teamId, target.userId)) === null) {
    return "You are no longer a member of this team.";
  }
  const tool = await deps.registry.resolve(target.teamId, frame.tool);
  if (tool === undefined) return `unknown_tool:${frame.tool.slice(0, 256)}`;
  const projectId = context.projectId ?? row.project_id ?? undefined;
  const scheduled = row.trigger === "schedule";
  const requested = scheduled ? "auto" : (context.approvalMode ?? "ask-on-write");
  const mode = clampApprovalMode(
    APPROVAL_MODES.includes(requested) ? requested : "ask-on-write",
    context.floor ?? "auto",
  );
  return {
    actor: { user_id: target.userId, kind: row.trigger },
    team_id: target.teamId,
    agent: {
      agent_id: row.agent_id,
      version: row.agent_version,
      tools_allow: [...(context.toolsAllow ?? [])],
      tools_deny: [...(context.toolsDeny ?? [])],
    },
    run: { run_id: frame.run_id, thread_id: row.thread_id, approval_mode: mode },
    tool,
    tool_call_id: frame.tool_call_id,
    ...(frame.parent_tool_call_id === undefined
      ? {}
      : { parent_tool_call_id: frame.parent_tool_call_id }),
    input: frame.input,
    context: {
      enforcement_point: "sandbox",
      ...(projectId === undefined ? {} : { project_id: projectId }),
    },
  } as PolicyInput;
}

async function recordDenied(
  db: KobeDb,
  teamId: string,
  frame: PolicyCheckFrame,
  reasons: readonly PolicyReason[],
) {
  try {
    await appendRunEvents(db, teamId, frame.run_id, [
      {
        type: "policy.denied",
        payload: { tool_call_id: frame.tool_call_id, tool: frame.tool, reasons: [...reasons] },
      },
    ]);
  } catch {
    // The run ended meanwhile, or the event did not fit its schema: the deny itself stands.
  }
}

/**
 * Decides one call. Never throws: any failure is a deny. `onPending` sends `policy.pending` when a
 * human is asked (the sandbox keeps waiting until `policy.result`).
 */
export async function decidePolicyCheck(
  deps: PolicyCheckDeps,
  target: SandboxTarget,
  frame: PolicyCheckFrame,
  signal: AbortSignal,
  onPending: (pending: { approvalId: string; expiresAt: string }) => void,
): Promise<PolicyResultFrame> {
  try {
    const input = await buildInput(deps, target, frame);
    if (typeof input === "string") {
      if (input.startsWith("unknown_tool:")) {
        const reason: PolicyReason = {
          code: "unknown_tool",
          stage: "install_deny",
          message: `${input.slice("unknown_tool:".length)} is not a known tool.`,
        };
        await recordDenied(deps.db, target.teamId, frame, [reason]);
        return denyFrame(frame, [reason], reason.message);
      }
      return denyFrame(frame, [], `${input} The tool call was denied.`);
    }
    const decision = await deps.engine.decide(input);
    if (decision.effect === "allow") {
      return {
        v: 1,
        type: "policy.result",
        request_id: frame.request_id,
        run_id: frame.run_id,
        tool_call_id: frame.tool_call_id,
        decision: "allow",
        reasons: decision.reasons,
      } satisfies Allow;
    }
    if (decision.effect === "deny") {
      await recordDenied(deps.db, target.teamId, frame, decision.reasons);
      return denyFrame(
        frame,
        decision.reasons,
        decision.reasons[0]?.message ?? "Denied by policy.",
      );
    }
    const outcome = await deps.approvals.request(
      {
        teamId: target.teamId,
        userId: target.userId,
        runId: frame.run_id,
        threadId: frame.thread_id,
        toolCallId: frame.tool_call_id,
        tool: frame.tool,
        input: frame.input,
        decision,
        signal,
      },
      onPending,
    );
    if (outcome.decision === "allow") {
      return {
        v: 1,
        type: "policy.result",
        request_id: frame.request_id,
        run_id: frame.run_id,
        tool_call_id: frame.tool_call_id,
        decision: "allow",
        reasons: [...outcome.reasons],
        ...(outcome.approval === undefined ? {} : { approval: outcome.approval }),
      } satisfies Allow;
    }
    await recordDenied(deps.db, target.teamId, frame, outcome.reasons);
    return denyFrame(frame, outcome.reasons, outcome.message);
  } catch {
    return denyFrame(
      frame,
      [],
      "Policy could not be evaluated, so the call was denied. Try again.",
    );
  }
}
