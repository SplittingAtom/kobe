import {
  APPROVAL_MODES,
  approvalModeSchema,
  type ApprovalMode,
  type PolicyCheckFrame,
  type PolicyEngine,
  type PolicyInput,
  type PolicyReason,
  type PolicyResultFrame,
  type ToolRegistry,
} from "@kobe/protocol";
import { eq, getMembership, sql, users, withTeam, type KobeDb } from "@kobe/db";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { readApprovalFloor, strictestApprovalMode } from "../policy/approval-floor.js";
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

/** The stricter of `mode` and `floor` (a run is never looser than the floor). */
export function clampApprovalMode(mode: ApprovalMode, floor: ApprovalMode): ApprovalMode {
  return strictestApprovalMode(mode, floor);
}

/** Server-side denials decided before the engine runs (protocol policy.ts: stage `install_deny`). */
export type ServerDenyCode = "policy_error" | "run_not_active" | "not_a_member" | "unknown_tool";

export function denyReason(code: ServerDenyCode, message: string): PolicyReason {
  return { code, stage: "install_deny", message: message.slice(0, 1000) };
}

type Deny = Extract<PolicyResultFrame, { decision: "deny" }>;
type Allow = Extract<PolicyResultFrame, { decision: "allow" }>;

/** A `deny` result; with no engine reasons, `code` names why (default `policy_error`). */
export function denyFrame(
  frame: PolicyCheckFrame,
  reasons: readonly PolicyReason[],
  message: string,
  code: ServerDenyCode = "policy_error",
): Deny {
  return {
    v: 1,
    type: "policy.result",
    request_id: frame.request_id,
    run_id: frame.run_id,
    tool_call_id: frame.tool_call_id,
    decision: "deny",
    reasons: reasons.length > 0 ? [...reasons] : [denyReason(code, message)],
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

/**
 * Run policy context from Postgres: the install floor (`readApprovalFloor`, spec D6: install-wide
 * only, no team floor) and the run's own mode, fixed at creation by the orchestrator
 * (`runs.approval_mode`, KOBE-30). Agent tool lists arrive with KOBE-47. An unreadable floor is the
 * strictest mode (`ask-all`); a failed read throws, and the call is denied.
 */
export function createDbRunContextSource(): RunPolicyContextSource {
  return {
    async load(tx, run) {
      const floor = await readApprovalFloor(tx);
      const res = await tx.execute<{ approval_mode: string }>(sql`
        SELECT approval_mode FROM runs WHERE team_id = ${run.teamId} AND id = ${run.runId}`);
      const mode = approvalModeSchema.safeParse(res.rows[0]?.approval_mode);
      return mode.success ? { floor, approvalMode: mode.data } : { floor };
    },
  };
}

export interface PolicyCheckDeps {
  readonly db: KobeDb;
  readonly engine: PolicyEngine;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly runContext: RunPolicyContextSource;
  /** Run event cap (`WireTuning.runMaxEvents`). */
  readonly runMaxEvents: number;
}

async function accountActive(db: KobeDb, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, userId));
  return row !== undefined && row.deactivatedAt === null;
}

/** Builds the engine input from server state, or the reason to deny instead. */
async function buildInput(
  deps: PolicyCheckDeps,
  target: SandboxTarget,
  frame: PolicyCheckFrame,
): Promise<PolicyInput | PolicyReason> {
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
  if (!loaded) return denyReason("run_not_active", "The run was not found.");
  const { row, context } = loaded;
  if (row.owner_user_id !== target.userId || row.thread_id !== frame.thread_id) {
    return denyReason("run_not_active", "The run does not belong to this sandbox.");
  }
  if (row.status !== "running" && row.status !== "waiting_approval") {
    return denyReason("run_not_active", "The run has ended.");
  }
  if (!(await accountActive(deps.db, target.userId))) {
    return denyReason("not_a_member", "The account is deactivated.");
  }
  if ((await getMembership(deps.db, target.teamId, target.userId)) === null) {
    return denyReason("not_a_member", "You are no longer a member of this team.");
  }
  const tool = await deps.registry.resolve(target.teamId, frame.tool);
  if (tool === undefined) {
    return denyReason("unknown_tool", `${frame.tool.slice(0, 256)} is not a known tool.`);
  }
  const projectId = context.projectId ?? row.project_id ?? undefined;
  const scheduled = row.trigger === "schedule";
  const requested = scheduled ? "auto" : (context.approvalMode ?? "ask-on-write");
  if (!APPROVAL_MODES.includes(context.floor)) {
    return denyReason("policy_error", "The approval mode floor is unavailable.");
  }
  const mode = clampApprovalMode(
    APPROVAL_MODES.includes(requested) ? requested : "ask-on-write",
    context.floor,
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
      // Required for MCP tools (protocol policy.ts). The engine applies the stricter of this and
      // the team's real exposure from its ConnectorStateSource, so the server's own state decides
      // (KOBE-37: without it every MCP call was `invalid_input`; KOBE-58/59 may narrow it here).
      ...(tool.source === "mcp" ? { connector_exposure: "all" as const } : {}),
    },
  } as PolicyInput;
}

/**
 * Appends `policy.denied` unless the run's budget for them is spent (`mayRecord`, a per-run token
 * bucket) or the run is at its event cap: a sandbox looping on denied calls can't grow the stream.
 */
async function recordDenied(
  deps: PolicyCheckDeps,
  teamId: string,
  frame: PolicyCheckFrame,
  reasons: readonly PolicyReason[],
  mayRecord: () => boolean,
) {
  if (!mayRecord()) return;
  try {
    await withAppendTx(deps.db, teamId, async (tx) => {
      const run = await tx.execute<{ last_seq: number }>(sql`
        SELECT last_seq FROM runs WHERE team_id = ${teamId} AND id = ${frame.run_id}`);
      // Keep room for the terminal event (as the ingest does).
      if ((run.rows[0]?.last_seq ?? deps.runMaxEvents) + 2 > deps.runMaxEvents) return;
      await appendRunEventsInTx(tx, teamId, frame.run_id, [
        {
          type: "policy.denied",
          payload: { tool_call_id: frame.tool_call_id, tool: frame.tool, reasons: [...reasons] },
        },
      ]);
    });
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
  target: SandboxTarget & { readonly connectionId: string },
  frame: PolicyCheckFrame,
  signal: AbortSignal,
  onPending: (pending: { approvalId: string; expiresAt: string }) => void,
  mayRecordDenied: () => boolean = () => true,
): Promise<PolicyResultFrame> {
  try {
    const input = await buildInput(deps, target, frame);
    if ("code" in input) {
      if (input.code === "unknown_tool") {
        await recordDenied(deps, target.teamId, frame, [input], mayRecordDenied);
        return denyFrame(frame, [input], input.message);
      }
      const message = `${input.message} The tool call was denied.`;
      return denyFrame(frame, [{ ...input, message }], message);
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
      await recordDenied(deps, target.teamId, frame, decision.reasons, mayRecordDenied);
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
        connectionId: target.connectionId,
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
    await recordDenied(deps, target.teamId, frame, outcome.reasons, mayRecordDenied);
    return denyFrame(frame, outcome.reasons, outcome.message);
  } catch {
    return denyFrame(
      frame,
      [],
      "Policy could not be evaluated, so the call was denied. Try again.",
    );
  }
}
