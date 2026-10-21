import { splitAppContext, splitSkillRequest } from "@kobe/protocol";
import {
  isActiveRunStatus,
  queueMayAdvance,
  type AppCardEntry,
  type ApprovalMode,
  type ErrorInfo,
  type PiThreadConfig,
  type RunProjectContext,
  type RunMcpContext,
  type RunViewingContext,
  type SandboxAttachment,
  type ThinkingLevel,
} from "@kobe/protocol";
import { projectRunContext } from "../projects/run-context.js";
import { listRunAttachments } from "../uploads/attach-list.js";
import { and, eq, runs, sql, type KobeTx } from "@kobe/db";
import { omittedItems } from "./omitted-event.js";
import { appCardChain, insertQueuedAppCardsInTx } from "../apps/app-cards.js";
import { piBranchPoint } from "./run-prompt.js";
import { appendRunEventsInTx, type NewRunEvent } from "../event-stream/append.js";
import { readApprovalFloor } from "../policy/approval-floor.js";
import { clampApprovalMode } from "../sandbox-wire/policy-check.js";
import {
  applyTransition,
  abortPending,
  isQueuePaused,
  lockThreadRow,
  principalActive,
  runViewing,
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
import { RUN_SKILLS_MAX, type Omission } from "../resolver/resolve.js";
import { recordRunSkillRefsInTx, skillUpdatesInTx } from "../skills/usage.js";
import type { CatalogTokenLimits } from "../models/token-limits.js";
import { runThinkingLevel } from "../models/thinking.js";
import {
  modelAcceptsImages,
  resolveRunModel,
  type RunModelConfig,
  type RunModelResolution,
} from "./models.js";
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
  /** Effective MCP connectors for Pi's per-session config (KOBE-111); dropped for older agents. */
  readonly mcp?: RunMcpContext;
  /** Project instructions context (KOBE-161), for a thread in a project its owner belongs to. */
  readonly project?: RunProjectContext;
  /** The message's uploads, already synced into the workspace (KOBE-144). */
  readonly attachments?: readonly SandboxAttachment[];
  /** What the resolver left out of the run's configuration (KOBE-76). */
  readonly omissions: readonly Omission[];
  /** The model's catalog limits (KOBE-259); the dispatcher fills in the site defaults. */
  readonly modelLimits?: CatalogTokenLimits;
  /** App cards Pi may not have yet, ending at the branch point (KOBE-440); absent = none. */
  readonly appCards?: readonly AppCardEntry[];
  /** The workspace file the member had open when sending (KOBE-462); absent = none. */
  readonly viewing?: RunViewingContext;
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

export function budgetStoppedEvent(scope: "site" | "team" | "user"): NewRunEvent {
  const whose = scope === "user" ? "your" : scope === "team" ? "the team's" : "the site's";
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
  // Waiting app cards wait too (re-review LOW-R2): Pi's last entries of the stopped run may still
  // be mirrored and move the leaf, which would leave a card on a side branch the model never sees.
  const hold = options.abortHoldMs ?? 0;
  if (hold > 0 && (await abortPending(tx, teamId, threadId, hold))) return { transitions };
  // App cards launched during the run that just ended go in first (KOBE-440, D17).
  if (!(await threadRunRows(tx, teamId, threadId)).some((r) => isActiveRunStatus(r.status))) {
    thread = { ...thread, ...(await insertQueuedAppCardsInTx(tx, teamId, thread)) };
  }
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
          : await fail(thread, next, startFailureCode(resolved.error.code));
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
    // KOBE-260: the conversation's level (or the model's default) clamped to the site and team.
    const thinkingLevel = startThinkingLevel(resolution, thread.thinkingLevel ?? null);
    const approvalMode = resolved.approvalMode;
    // An unsent prompt (KOBE-290) is not in Pi's session: Pi continues from its parent.
    const parentEntryId = await piBranchPoint(
      tx,
      teamId,
      threadId,
      next.parentEntryId ?? thread.leafEntryId,
    );
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
        ...(thinkingLevel === undefined ? {} : { thinking_level: thinkingLevel }),
        ...(next.retryOfRunId !== null ? { retry_of_run_id: next.retryOfRunId } : {}),
      },
    };
    const applied = await applyTransition(tx, thread, next, "running", "dequeued", started, {
      parentEntryId,
      approvalMode,
    });
    transitions.push(applied.transition);
    // The gateway reads the thinking level for every call of the run (KOBE-260): fixed now, never
    // raised. The agent version the run starts on (KOBE-420), read from the pin under the thread
    // lock like `run.started`'s: the chat marks where it changes between the thread's runs.
    await tx
      .update(runs)
      .set({
        agentVersion: resolved.agent?.version ?? null,
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      })
      .where(and(eq(runs.teamId, teamId), eq(runs.id, next.id)));
    await recordRunSkillRefsInTx(tx, teamId, next.id, resolved.skillRefs ?? []);
    await recordRunMcpInTx(tx, teamId, next.id, resolved);
    // KOBE-315 (CE12): skills at another version than this thread's last run with them.
    const updates = await skillUpdatesInTx(tx, teamId, threadId, next.id, resolved.skillRefs ?? []);
    if (updates.length > 0) {
      await appendRunEventsInTx(tx, teamId, next.id, [
        {
          type: "thread.skill_updated",
          payload: { thread_id: threadId, skills: updates.slice(0, RUN_SKILLS_MAX) },
        },
      ]);
    }
    // KOBE-77: what the resolver left out, right after `run.started` (never on a recovery restart).
    const items = omittedItems(resolved.omissions ?? []);
    if (items !== undefined) {
      await appendRunEventsInTx(tx, teamId, next.id, [
        { type: "context.omitted", payload: { items } },
      ]);
    }
    return {
      transitions,
      plan: withViewing(
        withAppCards(
          withProject(
            withAttachments(
              planOf(
                thread,
                { ...next, parentEntryId, approvalMode },
                resolved,
                model,
                resolution.limits,
                thinkingLevel,
              ),
              await listRunAttachments(
                tx,
                teamId,
                threadId,
                next.id,
                await modelAcceptsImages(tx, model?.alias),
              ),
            ),
            await projectRunContext(tx, { teamId, userId: thread.ownerUserId }, thread.projectId),
          ),
          await appCardChain(tx, teamId, threadId, parentEntryId),
        ),
        await runViewing(tx, teamId, next.id),
      ),
    };
  }
  return { transitions };
}

type Resolved = Extract<AgentResolution, { ok: true }>;

/** Resolution errors that keep their own code and message; any other is `agent_unavailable`. */
const OWN_START_CODES = new Set([
  "agent_suspended",
  "skill_draft_unavailable",
  "skill_draft_changed",
  "skill_draft_personal_off",
  "skill_draft_declined",
  "skill_not_available",
]);
const startFailureCode = (code: string) => (OWN_START_CODES.has(code) ? code : "agent_unavailable");

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

/**
 * The connectors of the run's `run.start.mcp` (KOBE-451 review HIGH-1), kept with the run: the
 * MCP proxy's decisions, lists and reveals allow only these for it (`mcp/run-context.ts`).
 */
async function recordRunMcpInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  resolved: Resolved,
): Promise<void> {
  const ids = (resolved.mcp?.servers ?? []).map((s) => s.connector_id);
  await tx
    .update(runs)
    .set({ mcpConnectorIds: ids })
    .where(and(eq(runs.teamId, teamId), eq(runs.id, runId)));
}

/** The skill a run's input asks for (the server's line after any app context), or null. */
export function requestedSkill(input: string): string | null {
  return splitSkillRequest(splitAppContext(input).rest).skill;
}

/** The thread's agent version for a start; the resolver may only tighten the run's mode. */
export async function resolveForStart(
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
      ...(thread.skillTest ? { skillTest: { draftId: thread.skillDraftId ?? null } } : {}),
      ...(thread.skillEval ? { skillEval: true as const } : {}),
    })
    .catch(() => ({ ok: false as const, error: { code: "agent_unavailable", message: "" } }));
  if (!resolved.ok) return resolved;
  // KOBE-451: a skill picked in the composer must still be in the run's effective set.
  const asked = requestedSkill(run.input);
  if (asked !== null && !(resolved.config?.skills ?? []).includes(asked)) {
    return { ok: false, error: { code: "skill_not_available", message: "" } };
  }
  // A scheduled run (D32, KOBE-174) is always `auto`: nobody is there to approve, so the agent
  // version's own (stricter) mode must not make it wait. Only the site floor tightens it.
  if (run.trigger === "schedule") {
    return {
      ...resolved,
      approvalMode: clampApprovalMode(run.approvalMode, await readApprovalFloor(tx)),
    };
  }
  return { ...resolved, approvalMode: clampApprovalMode(resolved.approvalMode, run.approvalMode) };
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
  modelLimits: CatalogTokenLimits | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): StartPlan {
  // The run's level replaces anything the resolver had (the server decides it, KOBE-260).
  const { model: _requested, thinking_level: _thinking, ...rest } = resolved.config ?? {};
  const config = {
    ...rest,
    ...(model === undefined ? {} : { model }),
    ...(model === undefined || thinkingLevel === undefined
      ? {}
      : { thinking_level: thinkingLevel }),
  };
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
    ...(resolved.mcp === undefined ? {} : { mcp: resolved.mcp }),
    ...(Object.keys(config).length > 0 ? { config } : {}),
    ...(model === undefined || modelLimits === undefined ? {} : { modelLimits }),
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
  // The re-sent start lists the skills resolved now: only those count as used (KOBE-297).
  await recordRunSkillRefsInTx(tx, run.teamId, run.id, resolved.skillRefs ?? [], true);
  await recordRunMcpInTx(tx, run.teamId, run.id, resolved);
  // The model the run started with (`run.started.model`), so a re-sent start does not switch
  // models; the resolver's alias only when the run had none.
  const started = await startedModelAlias(tx, run.teamId, run.id);
  const resolution = await resolveRunModel(
    tx,
    run.teamId,
    started ?? requestedModel(thread, resolved).alias,
  );
  if (!resolution.ok) return undefined;
  // The level the run started with (KOBE-260), clamped again to the current settings.
  const recorded = await recordedThinkingLevel(tx, run.teamId, run.id);
  const thinkingLevel =
    recorded === undefined ? undefined : startThinkingLevel(resolution, recorded);
  return withViewing(
    withAppCards(
      withProject(
        withAttachments(
          planOf(thread, run, resolved, resolution.model, resolution.limits, thinkingLevel),
          await listRunAttachments(
            tx,
            run.teamId,
            thread.id,
            run.id,
            await modelAcceptsImages(tx, resolution.model?.alias),
          ),
        ),
        await projectRunContext(
          tx,
          { teamId: run.teamId, userId: thread.ownerUserId },
          thread.projectId,
        ),
      ),
      await appCardChain(tx, run.teamId, thread.id, run.parentEntryId),
    ),
    await runViewing(tx, run.teamId, run.id),
  );
}

function withViewing(plan: StartPlan, viewing: RunViewingContext | null): StartPlan {
  return viewing === null ? plan : { ...plan, viewing };
}

function withAppCards(plan: StartPlan, appCards: readonly AppCardEntry[]): StartPlan {
  return appCards.length === 0 ? plan : { ...plan, appCards };
}

function withProject(plan: StartPlan, project: RunProjectContext | undefined): StartPlan {
  return project === undefined ? plan : { ...plan, project };
}

function withAttachments(plan: StartPlan, attachments: readonly SandboxAttachment[]): StartPlan {
  return attachments.length === 0 ? plan : { ...plan, attachments };
}

/** The run's thinking level: the chosen one clamped into the model's policy for the team. */
function startThinkingLevel(
  resolution: Extract<RunModelResolution, { ok: true }>,
  chosen: ThinkingLevel | null,
): ThinkingLevel | undefined {
  if (resolution.model === undefined || resolution.thinking === undefined) return undefined;
  return runThinkingLevel(resolution.thinking.site, resolution.thinking.teamMax, chosen);
}

/** The level a run started with (`runs.thinking_level`), if any. */
async function recordedThinkingLevel(
  tx: KobeTx,
  teamId: string,
  runId: string,
): Promise<ThinkingLevel | undefined> {
  const [row] = await tx
    .select({ level: runs.thinkingLevel })
    .from(runs)
    .where(and(eq(runs.teamId, teamId), eq(runs.id, runId)));
  return row?.level ?? undefined;
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
