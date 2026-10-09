import {
  isActiveRunStatus,
  queueMayAdvance,
  type ApprovalMode,
  type ErrorInfo,
  type PiThreadConfig,
  type RunProjectContext,
  type SandboxAttachment,
} from "@kobe/protocol";
import { projectRunContext } from "../projects/run-context.js";
import { listRunAttachments } from "../uploads/attach-list.js";
import { sql, type KobeTx } from "@kobe/db";
import { omittedItems } from "./omitted-event.js";
import { appendRunEventsInTx, type NewRunEvent } from "../event-stream/append.js";
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
import {
  FAILURE_MESSAGES,
  agentModelNotEnabled,
  failureInfo,
  threadModelNotEnabled,
} from "./failure-codes.js";
import type { Omission } from "../resolver/resolve.js";
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
  readonly agent: {
    readonly agentId: string;
    readonly version: number | null;
    readonly draftRevision?: number;
  } | null;
  readonly config?: Omit<PiThreadConfig, "agent" | "approval_mode">;
  /** Project instructions context (KOBE-161), for a thread in a project its owner belongs to. */
  readonly project?: RunProjectContext;
  /** The message's uploads, already synced into the workspace (KOBE-144). */
  readonly attachments?: readonly SandboxAttachment[];
  /** What the resolver left out of the run's configuration (KOBE-76). */
  readonly omissions: readonly Omission[];
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
  const fail = async (
    t: ThreadRow,
    run: RunRow,
    code: string,
    event: NewRunEvent = failedEvent(code),
  ): Promise<ThreadRow> => {
    const applied = await applyTransition(tx, t, run, "failed", "error", event);
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
      // The agent's pinned model is not enabled for the team: the agreed error, no fallback.
      thread =
        resolved.error.code === "agent_model_not_enabled"
          ? await fail(thread, next, resolved.error.code, {
              type: "run.failed",
              payload: { error: resolved.error },
            })
          : await fail(
              thread,
              next,
              resolved.error.code === "agent_suspended" ? "agent_suspended" : "agent_unavailable",
            );
      continue;
    }
    const requested = requestedModel(thread, resolved);
    const resolution = await resolveRunModel(tx, teamId, requested.alias);
    if (!resolution.ok) {
      // The thread's or agent's model is not enabled for this team: a clear failure, no fallback.
      thread = await fail(thread, next, resolution.code, {
        type: "run.failed",
        payload: {
          error:
            requested.source === "thread"
              ? threadModelNotEnabled(resolution.alias)
              : agentModelNotEnabled(resolution.alias),
        },
      });
      continue;
    }
    const model = resolution.model;
    const approvalMode = resolved.approvalMode;
    const parentEntryId = next.parentEntryId ?? thread.leafEntryId;
    const started: NewRunEvent = {
      type: "run.started",
      payload: {
        thread_id: threadId,
        agent_id: resolved.agent?.agentId ?? null,
        agent_version: resolved.agent?.version ?? null,
        ...(resolved.agent?.draftRevision === undefined
          ? {}
          : { draft_revision: resolved.agent.draftRevision }),
        ...(model === undefined ? {} : { model: model.alias, model_source: requested.source }),
        ...(next.retryOfRunId !== null ? { retry_of_run_id: next.retryOfRunId } : {}),
      },
    };
    const applied = await applyTransition(tx, thread, next, "running", "dequeued", started, {
      parentEntryId,
      approvalMode,
    });
    transitions.push(applied.transition);
    // KOBE-77: what the resolver left out, right after `run.started` (never on a recovery restart).
    const items = omittedItems(resolved.omissions ?? []);
    if (items !== undefined) {
      await appendRunEventsInTx(tx, teamId, next.id, [
        { type: "context.omitted", payload: { items } },
      ]);
    }
    return {
      transitions,
      plan: withProject(
        withAttachments(
          planOf(thread, { ...next, parentEntryId, approvalMode }, resolved, model),
          await listRunAttachments(tx, teamId, threadId, next.id),
        ),
        await projectRunContext(tx, { teamId, userId: thread.ownerUserId }, thread.projectId),
      ),
    };
  }
  return { transitions };
}

type Resolved = Extract<AgentResolution, { ok: true }>;

/** Where a run's model came from (KOBE-44), recorded in `run.started.model_source`. */
export type ModelSource = "agent" | "thread" | "default";

/**
 * The run's requested model alias (KOBE-44, D30): the agent's pin (KOBE-47) when it sets one, else
 * the model the thread's owner chose for the conversation, else none (the team's default). User
 * decision (2026-10-04): the agent's pinned model wins over the conversation's choice.
 */
export function requestedModel(
  thread: Pick<ThreadRow, "modelAlias">,
  resolved: Pick<Resolved, "config">,
): { readonly alias: string | undefined; readonly source: ModelSource } {
  const pinned = resolved.config?.model?.alias;
  if (pinned !== undefined) return { alias: pinned, source: "agent" };
  if (thread.modelAlias !== null) return { alias: thread.modelAlias, source: "thread" };
  return { alias: undefined, source: "default" };
}

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
    omissions: resolved.omissions ?? [],
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
  const resolution = await resolveRunModel(
    tx,
    run.teamId,
    started ?? requestedModel(thread, resolved).alias,
  );
  if (!resolution.ok) return undefined;
  return withProject(
    withAttachments(
      planOf(thread, run, resolved, resolution.model),
      await listRunAttachments(tx, run.teamId, thread.id, run.id),
    ),
    await projectRunContext(
      tx,
      { teamId: run.teamId, userId: thread.ownerUserId },
      thread.projectId,
    ),
  );
}

function withProject(plan: StartPlan, project: RunProjectContext | undefined): StartPlan {
  return project === undefined ? plan : { ...plan, project };
}

function withAttachments(plan: StartPlan, attachments: readonly SandboxAttachment[]): StartPlan {
  return attachments.length === 0 ? plan : { ...plan, attachments };
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
