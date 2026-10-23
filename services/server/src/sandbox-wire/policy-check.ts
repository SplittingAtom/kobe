import {
  APPROVAL_MODES,
  MEMORY_TOOLS,
  PROJECT_TOOLS,
  approvalModeSchema,
  type ApprovalMode,
  type PolicyCheckFrame,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyInput,
  type PolicyReason,
  type PolicyResultFrame,
  type ToolRegistry,
} from "@kobe/protocol";
import { eq, getMembership, sql, users, withTeam, type KobeDb } from "@kobe/db";
import { logger } from "../logger.js";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { readApprovalFloor, strictestApprovalMode } from "../policy/approval-floor.js";
import { neverPromptReason } from "../policy/evaluate.js";
import { appliedUserRule, recordRuleApplied } from "../policy/rule-applied.js";
import { appliedDangerousMode, recordDangerousApplied } from "../policy/dangerous-mode.js";
import { loadRunAgentTools } from "../policy/run-agent-tools.js";
import { recordSkippedActionInTx } from "../policy/skipped-actions.js";
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

/**
 * The tools a call may run without asking under Dangerous mode (AC1): the run's agent's explicit
 * list when the site floor sets no minimum (`auto`); any stricter site floor turns it off.
 */
export function dangerousToolsFor(context: {
  readonly dangerousTools?: readonly string[];
  readonly floor: ApprovalMode;
}): string[] {
  return context.floor === "auto" ? [...(context.dangerousTools ?? [])] : [];
}

/** Server-side denials decided before the engine runs (protocol policy.ts: stage `site_deny`). */
export type ServerDenyCode = "policy_error" | "run_not_active" | "not_a_member" | "unknown_tool";

export function denyReason(code: ServerDenyCode, message: string): PolicyReason {
  return { code, stage: "site_deny", message: message.slice(0, 1000) };
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
 * Run policy context from Postgres: the site floor (`readApprovalFloor`, spec D6: site-wide
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
      // KOBE-481: the agent's own tools.deny in every mode; AC1: its Dangerous tools.
      const agent = await loadRunAgentTools(tx, run);
      return {
        floor,
        ...(mode.success ? { approvalMode: mode.data } : {}),
        toolsDeny: agent.toolsDeny,
        ...(agent.dangerousTools.length > 0 ? { dangerousTools: agent.dangerousTools } : {}),
      };
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
  /** Pause before the single retry of a failed evaluation (default 150 ms). */
  readonly retryDelayMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 150;

export type Evaluated =
  | { readonly reason: PolicyReason }
  | { readonly input: PolicyInput; readonly decision: PolicyDecision };

/** The engine's own fail-closed deny (an internal error, already reported through `onError`). */
function isInternalError(decision: PolicyDecision): boolean {
  const first = decision.reasons[0];
  return (
    decision.effect === "deny" &&
    first?.code === "policy_error" &&
    first.message.startsWith("Policy could not be evaluated")
  );
}

/**
 * Builds the input and asks the engine. Both are read-only, so a transient failure (a pooled
 * connection dropped or timed out under load, KOBE-242) is retried once before the call is denied;
 * a second failure still denies (fail closed) and is logged with its cause.
 */
async function evaluateOnce(
  deps: PolicyCheckDeps,
  target: SandboxTarget,
  frame: PolicyCheckFrame,
): Promise<Evaluated> {
  const input = await buildInput(deps, target, frame);
  if ("code" in input) return { reason: input };
  return { input, decision: await deps.engine.decide(input) };
}

export async function retryEvaluation(
  run: () => Promise<Evaluated>,
  delayMs: number,
  onError: (err: unknown, attempt: number) => void,
): Promise<Evaluated> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const out = await run();
      if (!("decision" in out) || !isInternalError(out.decision) || attempt > 1) return out;
    } catch (err) {
      onError(err, attempt);
      if (attempt > 1) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function evaluateWithRetry(deps: PolicyCheckDeps, target: SandboxTarget, frame: PolicyCheckFrame) {
  return retryEvaluation(
    () => evaluateOnce(deps, target, frame),
    deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    (err, attempt) =>
      logger.error(
        { err, attempt, runId: frame.run_id, tool: frame.tool },
        "policy.check evaluation failed",
      ),
  );
}

async function accountActive(db: KobeDb, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, userId));
  return row !== undefined && row.deactivatedAt === null;
}

const EVAL_NO_PROMPT: PolicyReason = {
  code: "eval_run_no_prompt",
  stage: "prompt",
  message: "Skill eval runs never ask for approval; this call was denied.",
};

const EVAL_ISOLATED: PolicyReason = {
  code: "eval_run_isolated",
  stage: "prompt",
  message:
    "Skill evals never use your memory, projects or synced workspace files; this call was denied.",
};
/**
 * Never in an eval run: memory, projects, `propose_file_edit` (KOBE-462) and `open_file`
 * (KOBE-484), which read and target the member's synced workspace, not the eval sandbox's files.
 */
const EVAL_ISOLATED_TOOLS: ReadonlySet<string> = new Set([
  ...MEMORY_TOOLS,
  ...PROJECT_TOOLS,
  "propose_file_edit",
  "open_file",
]);

/**
 * `run_python` with a `path` (KOBE-464) runs the member's synced copy and saves into it: in an eval
 * run only `code` is allowed, which runs in the eval sandbox's own kernel like bash.
 */
function evalIsolatedCall(tool: string, input: unknown): boolean {
  if (EVAL_ISOLATED_TOOLS.has(tool)) return true;
  return (
    tool === "run_python" &&
    typeof input === "object" &&
    input !== null &&
    (input as { path?: unknown }).path !== undefined
  );
}

async function isEvalThread(db: KobeDb, teamId: string, threadId: string): Promise<boolean> {
  const res = await withTeam(db, teamId, (tx) =>
    tx.execute<{ skill_eval: boolean }>(sql`
      SELECT skill_eval FROM threads WHERE team_id = ${teamId} AND id = ${threadId}`),
  );
  return res.rows[0]?.skill_eval === true;
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
      kind: string;
      trigger: "user" | "schedule";
      thread_id: string;
      owner_user_id: string;
      agent_id: string | null;
      agent_version: number | null;
      project_id: string | null;
    }>(sql`
      SELECT r.status, r.kind, r.trigger, r.thread_id, t.owner_user_id, t.agent_id, t.agent_version,
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
  // A compaction (KOBE-213) makes no tool calls (the wire refuses them first; second line).
  if (row.kind !== "message") {
    return denyReason("run_not_active", "A compaction makes no tool calls.");
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
      dangerous_tools: dangerousToolsFor(context),
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
 * A scheduled run's denied call (D32), recorded for the run's report. Only scheduled runs get a row
 * (the insert checks the run's trigger itself). A failure is logged: the deny stands either way.
 */
async function recordSkipped(
  deps: PolicyCheckDeps,
  teamId: string,
  frame: PolicyCheckFrame,
  risk: PolicyDecision["risk"],
  reasons: readonly PolicyReason[],
): Promise<void> {
  const reason = reasons[0];
  if (reason === undefined) return;
  try {
    await withTeam(deps.db, teamId, (tx) =>
      recordSkippedActionInTx(tx, {
        teamId,
        runId: frame.run_id,
        toolCallId: frame.tool_call_id,
        tool: frame.tool,
        risk,
        reason: reason.code,
      }),
    );
  } catch (err) {
    logger.warn({ err, runId: frame.run_id }, "could not record a skipped action");
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
    const evaluated = await evaluateWithRetry(deps, target, frame);
    if ("reason" in evaluated) {
      const input = evaluated.reason;
      if (input.code === "unknown_tool") {
        await recordDenied(deps, target.teamId, frame, [input], mayRecordDenied);
        await recordSkipped(deps, target.teamId, frame, "destructive", [input]);
        return denyFrame(frame, [input], input.message);
      }
      const message = `${input.message} The tool call was denied.`;
      return denyFrame(frame, [{ ...input, message }], message);
    }
    const { decision } = evaluated;
    // A skill eval's run (KOBE-325) never reads or writes the member's memory or projects: an eval
    // measures the skill alone and leaves nothing behind in the member's own state.
    const evalRun = await isEvalThread(deps.db, target.teamId, frame.thread_id);
    if (evalRun && evalIsolatedCall(frame.tool, frame.input)) {
      const reasons = [EVAL_ISOLATED];
      await recordDenied(deps, target.teamId, frame, reasons, mayRecordDenied);
      await recordSkipped(deps, target.teamId, frame, decision.risk, reasons);
      return denyFrame(frame, reasons, EVAL_ISOLATED.message);
    }
    if (decision.effect === "allow") {
      // A remembered approval allowed it (KOBE-289): recorded first (last used, audit, tool card).
      // A rule revoked meanwhile, or a failed record, denies the call instead.
      const rule = appliedUserRule(decision);
      // A skill eval (KOBE-325) is measured on team and site rules only, the same for every
      // starter: a remembered approval doesn't apply, and without it the call would ask.
      if (rule !== undefined && evalRun) {
        const reasons = [
          EVAL_NO_PROMPT,
          ...decision.reasons.filter((r) => r.code !== "user_allow_rule"),
        ];
        await recordDenied(deps, target.teamId, frame, reasons, mayRecordDenied);
        await recordSkipped(deps, target.teamId, frame, decision.risk, reasons);
        return denyFrame(frame, reasons, EVAL_NO_PROMPT.message);
      }
      // An admin's Dangerous agent allowed it (AC1): audited before the call runs; a skill eval
      // never runs on it (defence in depth: the context source never sets it there), and a failed
      // audit write denies the call.
      if (appliedDangerousMode(decision) !== undefined) {
        if (evalRun) {
          const reasons = [EVAL_NO_PROMPT];
          await recordDenied(deps, target.teamId, frame, reasons, mayRecordDenied);
          await recordSkipped(deps, target.teamId, frame, decision.risk, reasons);
          return denyFrame(frame, reasons, EVAL_NO_PROMPT.message);
        }
        try {
          await recordDangerousApplied(deps.db, {
            teamId: target.teamId,
            userId: target.userId,
            runId: frame.run_id,
            agentId: evaluated.input.agent.agent_id,
            agentVersion: evaluated.input.agent.version,
            toolCallId: frame.tool_call_id,
            tool: frame.tool,
            enforcementPoint: "sandbox",
          });
        } catch (err) {
          logger.error({ err, runId: frame.run_id }, "dangerous mode audit failed; call denied");
          const message = "The call could not be audited, so it was denied.";
          return denyFrame(frame, [denyReason("policy_error", message)], message);
        }
      }
      if (rule?.rule_id !== undefined) {
        const recorded = await recordRuleApplied(deps.db, {
          teamId: target.teamId,
          userId: target.userId,
          runId: frame.run_id,
          toolCallId: frame.tool_call_id,
          tool: frame.tool,
          ruleId: rule.rule_id,
          enforcementPoint: "sandbox",
          runMaxEvents: deps.runMaxEvents,
          announce: true,
        });
        if (!recorded) {
          const message = "The remembered approval for this call was revoked; it was denied.";
          return denyFrame(frame, [denyReason("policy_error", message)], message);
        }
      }
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
      await recordSkipped(deps, target.teamId, frame, decision.risk, decision.reasons);
      return denyFrame(
        frame,
        decision.reasons,
        decision.reasons[0]?.message ?? "Denied by policy.",
      );
    }
    // Defence in depth (the engine never asks here): nobody can answer a scheduled or auto run,
    // so no approval row is created for it and the sandbox is not left waiting.
    const never = neverPromptReason(evaluated.input);
    if (never !== undefined) {
      const reasons = [never, ...decision.reasons];
      await recordDenied(deps, target.teamId, frame, reasons, mayRecordDenied);
      await recordSkipped(deps, target.teamId, frame, decision.risk, reasons);
      return denyFrame(frame, reasons, never.message);
    }
    // A skill eval's run (KOBE-325) never asks either, whatever mode the floor clamped it to: the
    // call is denied and recorded (its `no_denied_tools` check reads the denial).
    if (evalRun) {
      const reasons = [EVAL_NO_PROMPT, ...decision.reasons];
      await recordDenied(deps, target.teamId, frame, reasons, mayRecordDenied);
      await recordSkipped(deps, target.teamId, frame, decision.risk, reasons);
      return denyFrame(frame, reasons, EVAL_NO_PROMPT.message);
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
  } catch (err) {
    logger.error({ err, runId: frame.run_id, tool: frame.tool }, "policy.check denied on error");
    return denyFrame(
      frame,
      [],
      "Policy could not be evaluated, so the call was denied. Try again.",
    );
  }
}
