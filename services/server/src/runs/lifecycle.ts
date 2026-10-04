import {
  isActiveRunStatus,
  queueMayAdvance,
  type ApprovalMode,
  type ErrorInfo,
  type PiThreadConfig,
} from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import type { NewRunEvent } from "../event-stream/append.js";
import { clampApprovalMode } from "../sandbox-wire/policy-check.js";
import {
  applyTransition,
  abortPending,
  isQueuePaused,
  lockThreadRow,
  principalActive,
  threadRunRows,
  type AppliedTransition,
  type RunRow,
  type ThreadRow,
} from "./store.js";
import { FAILURE_MESSAGES, failureInfo } from "./failure-codes.js";
import { resolveRunModel, type RunModelConfig } from "./models.js";
import type { AgentResolution, RunAgentResolver } from "./seams.js";

/** Everything a replica needs to send `run.start` for a run it just moved to `running`. */
export interface StartPlan {
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  /** The sandbox is the thread owner's (D11: one sandbox per user and team). */
  readonly ownerUserId: string;
  readonly input: string;
  readonly parentEntryId: string | null;
  readonly approvalMode: ApprovalMode;
  readonly agent: { readonly agentId: string; readonly version: number } | null;
  readonly config?: Omit<PiThreadConfig, "agent" | "approval_mode">;
}

export interface Promotion {
  readonly plan?: StartPlan;
  readonly transitions: readonly AppliedTransition[];
}

/**
 * A `run.failed` event with a message of the server's own (failure-codes.ts): the sandbox's text
 * is untrusted and is never shown to the user (only logged by the caller).
 */
export function failedEvent(code: string): NewRunEvent {
  // Codes the orchestrator does not know become `start_failed` (as before KOBE-41).
  const known = Object.hasOwn(FAILURE_MESSAGES, code) ? code : "start_failed";
  const error: ErrorInfo = failureInfo(known, "start_failed");
  return { type: "run.failed", payload: { error } };
}

/** The terminal event of a Stop (§6.2 has no `run.cancelled`: the contract uses this). */
export function cancelledEvent(thread: ThreadRow): NewRunEvent {
  return {
    type: "run.interrupted",
    payload: { reason: "cancelled", last_entry_id: thread.leafEntryId, retryable: false },
  };
}

export function budgetStoppedEvent(scope: "install" | "team" | "user"): NewRunEvent {
  const whose = scope === "user" ? "your" : scope === "team" ? "the team's" : "the install's";
  return {
    type: "run.budget_stopped",
    payload: { scope, message: `The run stopped because ${whose} budget is used up.` },
  };
}

/** Bound on queued runs inspected per promotion (each failure moves on to the next). */
const MAX_PROMOTION_STEPS = 64;

/**
 * Starts the thread's next run if it may start now (D14, D17): no active run, not in Trash, the
 * queue may advance (`queueMayAdvance`) and is not paused by a Stop (KOBE-26) — except a retry, which starts ahead of the queue even on
 * an interrupted thread. The run moves `queued → running` with `run.started`, its branch point
 * fixed (requested parent, else the thread's leaf), its agent version resolved and its mode
 * tightened by the resolver (KOBE-46/47). Nothing starts while Pi is still aborting a stopped run
 * of the thread (`abortHoldMs`, the Stop grace). A run that can't start (owner deactivated or removed,
 * agent unavailable) fails visibly and the next one is tried. Locks the thread first.
 */
export async function promoteInTx(
  tx: KobeTx,
  agents: RunAgentResolver,
  teamId: string,
  threadId: string,
  options: { readonly abortHoldMs?: number } = {},
): Promise<Promotion> {
  const transitions: AppliedTransition[] = [];
  let thread = await lockThreadRow(tx, teamId, threadId);
  if (!thread || thread.deletedAt !== null) return { transitions };
  // Pi is still aborting a stopped run of this thread: the next start would be refused (KOBE-26).
  const hold = options.abortHoldMs ?? 0;
  if (hold > 0 && (await abortPending(tx, teamId, threadId, hold))) return { transitions };
  // Stop paused the queue (KOBE-26): it waits for Resume or a new message.
  const paused = await isQueuePaused(tx, teamId, threadId);
  const fail = async (t: ThreadRow, run: RunRow, code: string): Promise<ThreadRow> => {
    const applied = await applyTransition(tx, t, run, "failed", "error", failedEvent(code));
    transitions.push(applied.transition);
    return { ...t, status: applied.threadStatus };
  };
  for (let step = 0; step < MAX_PROMOTION_STEPS; step += 1) {
    const rows = await threadRunRows(tx, teamId, threadId);
    if (rows.some((r) => isActiveRunStatus(r.status))) return { transitions };
    const next = rows.find((r) => r.status === "queued");
    if (!next) return { transitions };
    if (next.retryOfRunId === null && (paused || !queueMayAdvance(thread.status))) {
      return { transitions };
    }
    if (!(await principalActive(tx, teamId, thread.ownerUserId))) {
      // The owner can't run anything (KOBE-13): their queued messages fail visibly.
      for (const queued of rows.filter((r) => r.status === "queued")) {
        thread = await fail(thread, queued, "account_inactive");
      }
      return { transitions };
    }
    const resolved = await resolveForStart(tx, agents, thread, next);
    if (!resolved.ok) {
      thread = await fail(thread, next, "agent_unavailable");
      continue;
    }
    const approvalMode = resolved.approvalMode;
    const parentEntryId = next.parentEntryId ?? thread.leafEntryId;
    const model = await resolveRunModel(tx, teamId, resolved.config?.model?.alias);
    const started: NewRunEvent = {
      type: "run.started",
      payload: {
        thread_id: threadId,
        agent_id: resolved.agent?.agentId ?? null,
        agent_version: resolved.agent?.version ?? null,
        ...(model === undefined ? {} : { model: model.alias }),
        ...(next.retryOfRunId !== null ? { retry_of_run_id: next.retryOfRunId } : {}),
      },
    };
    const applied = await applyTransition(tx, thread, next, "running", "dequeued", started, {
      parentEntryId,
      approvalMode,
    });
    transitions.push(applied.transition);
    return {
      transitions,
      plan: planOf(thread, { ...next, parentEntryId, approvalMode }, resolved, model),
    };
  }
  return { transitions };
}

type Resolved = Extract<AgentResolution, { ok: true }>;

/** The thread's agent version for a start; the resolver may only tighten the run's mode. */
async function resolveForStart(
  tx: KobeTx,
  agents: RunAgentResolver,
  thread: ThreadRow,
  run: RunRow,
): Promise<AgentResolution> {
  // A resolver that throws must not poison the queue: the run fails like any resolution error.
  const resolved = await agents
    .resolve(tx, {
      teamId: run.teamId,
      ownerUserId: thread.ownerUserId,
      threadId: thread.id,
      runId: run.id,
      trigger: run.trigger,
      agentScope: thread.agentScope,
      agentId: thread.agentId,
      agentVersion: thread.agentVersion,
      approvalMode: run.approvalMode,
    })
    .catch(() => ({ ok: false as const, error: { code: "agent_unavailable", message: "" } }));
  return resolved.ok
    ? { ...resolved, approvalMode: clampApprovalMode(resolved.approvalMode, run.approvalMode) }
    : resolved;
}

/**
 * The plan's Pi config: the resolver's, with the run's model as resolved from the catalog (KOBE-41;
 * the resolver's alias alone names no gateway model). No model → no `config.model`: the sandbox
 * agent fails the run `model_not_configured`.
 */
function planOf(
  thread: ThreadRow,
  run: RunRow,
  resolved: Resolved,
  model: RunModelConfig | undefined,
): StartPlan {
  const { model: _requested, ...rest } = resolved.config ?? {};
  const config = { ...rest, ...(model === undefined ? {} : { model }) };
  return {
    teamId: run.teamId,
    runId: run.id,
    threadId: thread.id,
    ownerUserId: thread.ownerUserId,
    input: run.input,
    parentEntryId: run.parentEntryId,
    approvalMode: resolved.approvalMode,
    agent: resolved.agent,
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

/**
 * The start plan of a `running` run whose `run.start` was lost (recovery): its branch point and
 * mode were fixed when it started; the agent version is resolved again. Undefined when it can't
 * resolve (the caller fails the run).
 */
export async function restartPlanInTx(
  tx: KobeTx,
  agents: RunAgentResolver,
  thread: ThreadRow,
  run: RunRow,
): Promise<StartPlan | undefined> {
  const resolved = await resolveForStart(tx, agents, thread, run);
  if (!resolved.ok) return undefined;
  // The model the run started with (`run.started.model`), so a re-sent start does not switch
  // models; the resolver's alias only when the run had none.
  const started = await startedModelAlias(tx, run.teamId, run.id);
  const model = await resolveRunModel(tx, run.teamId, started ?? resolved.config?.model?.alias);
  return planOf(thread, run, resolved, model);
}

/** The alias in the run's `run.started` event, if any. */
export async function startedModelAlias(
  tx: KobeTx,
  teamId: string,
  runId: string,
): Promise<string | undefined> {
  const res = await tx.execute<{ model: string | null }>(sql`
    SELECT payload->>'model' AS model FROM run_events
     WHERE team_id = ${teamId} AND run_id = ${runId} AND type = 'run.started'
     ORDER BY seq LIMIT 1`);
  const model = res.rows[0]?.model;
  return typeof model === "string" && model !== "" ? model : undefined;
}
