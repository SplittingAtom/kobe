import {
  compactThreadResponseSchema,
  isActiveRunStatus,
  type ActorContext,
  type CompactThreadErrorCode,
  type CompactThreadResponse,
} from "@kobe/protocol";
import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import {
  effectiveModelLimits,
  type CatalogTokenLimits,
  type ModelTokenDefaults,
} from "../models/token-limits.js";
import { endRunInTx } from "../sandbox-wire/run-state.js";
import type { CommandOutcome, SandboxRouter } from "../sandbox-wire/types.js";
import type { Viewer } from "../threads/repository.js";
import { lockOwnedThread } from "./access.js";
import { failureInfo } from "./failure-codes.js";
import { requestedModel, resolveForStart } from "./lifecycle.js";
import { resolveRunModel, type RunModelConfig } from "./models.js";
import type { RunAgentResolver } from "./seams.js";
import { getRunRow, requestStop, threadRunRows, type ThreadRow } from "./store.js";
import type { StopTarget } from "./dispatch.js";

/**
 * Compact now (KOBE-213, CE15): a compaction is a run of kind `compaction`. It is created running
 * under the thread lock (the one-active-run rule refuses a busy thread: `thread_busy`; it is never
 * queued), its `thread.compact` is delivered like a `run.start` (wake, entry sync or restore,
 * lease, run token), the delivering replica mirrors Pi's `compaction` entry and ends the run, and
 * the requester answers the member with the result or a fixed message per code (the sandbox's text
 * is logged only). Pi owns the summary; Kobe never summarizes.
 */
export class CompactionError extends Error {
  constructor(readonly code: CompactThreadErrorCode) {
    super(code);
    this.name = "CompactionError";
  }
}

/** What the orchestrator lends a compaction. */
export interface CompactionHost {
  readonly db: KobeDb;
  readonly router: SandboxRouter;
  readonly agents: RunAgentResolver;
  readonly modelTokenDefaults: ModelTokenDefaults;
  readonly log: Logger;
  /** A team transaction as `actor` with the thread lock timeout (busy → `thread_busy`). */
  threadTx<T>(actor: ActorContext, fn: (tx: KobeTx, viewer: Viewer) => Promise<T>): Promise<T>;
  /** Account active, still a member, budget left (KOBE-13, KOBE-42). */
  assertMayRun(tx: KobeTx, actor: ActorContext): Promise<void>;
  /** The run ended: advance the thread's queue (messages sent meanwhile wait behind it). */
  ended(teamId: string, runId: string, threadId: string): Promise<void>;
  /** Pi must abort the compaction (it may still be summarizing). */
  abort(target: StopTarget): void;
}

interface Started {
  readonly runId: string;
  readonly thread: ThreadRow;
  readonly model: RunModelConfig;
  readonly limits: CatalogTokenLimits | undefined;
}

/** Sandbox and wire codes as the member sees them; anything else is `compaction_failed`. */
const HTTP_CODE: Readonly<Record<string, CompactThreadErrorCode>> = {
  thread_busy: "thread_busy",
  nothing_to_compact: "nothing_to_compact",
  model_not_configured: "model_not_configured",
  sandbox_unavailable: "sandbox_unavailable",
  isolation_runtime_missing: "sandbox_unavailable",
  workspace_unavailable: "sandbox_unavailable",
  pi_unavailable: "sandbox_unavailable",
  connection_lost: "sandbox_unavailable",
  unavailable: "sandbox_unavailable",
  session_unavailable: "sandbox_unavailable",
  timeout: "sandbox_unavailable",
};

export async function compactThread(
  host: CompactionHost,
  actor: ActorContext,
  threadId: string,
  focus: string | undefined,
): Promise<CompactThreadResponse> {
  const started = await host.threadTx(actor, (tx, viewer) =>
    startInTx(host, tx, viewer, actor, threadId),
  );
  const { runId, thread } = started;
  const outcome = await host.router
    .compactThread(
      { teamId: actor.team_id, userId: thread.ownerUserId },
      {
        runId,
        threadId: thread.id,
        ...(focus === undefined ? {} : { focus }),
        model: {
          alias: started.model.alias,
          gateway_model: started.model.gateway_model,
          api: started.model.api,
        },
        ...(started.limits === undefined
          ? {}
          : { modelLimits: effectiveModelLimits(started.limits, host.modelTokenDefaults) }),
      },
    )
    .catch((err: unknown): CommandOutcome => ({
      ok: false,
      error: { code: "internal", message: (err as Error).message },
    }));
  const result = outcome.ok ? parseResult(thread.id, outcome.data) : undefined;
  const code = outcome.ok ? (result ? undefined : "compaction_failed") : httpCode(outcome);
  if (!outcome.ok) {
    // The sandbox's text is untrusted: logged (capped), never answered.
    host.log.warn(
      { run_id: runId, code: outcome.error.code, error: outcome.error.message.slice(0, 300) },
      "compaction failed",
    );
  } else if (!result) {
    host.log.warn({ run_id: runId }, "the sandbox sent a malformed compaction result");
  }
  await finish(host, actor, started, code, focus !== undefined);
  if (code !== undefined) throw new CompactionError(code);
  return result as CompactThreadResponse;
}

async function startInTx(
  host: CompactionHost,
  tx: KobeTx,
  viewer: Viewer,
  actor: ActorContext,
  threadId: string,
): Promise<Started> {
  const teamId = actor.team_id;
  const thread = await lockOwnedThread(tx, viewer, threadId, "thread_not_found");
  await host.assertMayRun(tx, actor);
  // Only an idle thread: a run (or a compaction) holds it; an interrupted one waits on Retry.
  const active = (await threadRunRows(tx, teamId, thread.id)).some((r) =>
    isActiveRunStatus(r.status),
  );
  if (active || thread.status !== "idle") throw new CompactionError("thread_busy");
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO runs (team_id, thread_id, trigger, kind, status, started_at)
    VALUES (${teamId}, ${thread.id}, 'user', 'compaction', 'running', now())
    RETURNING id`);
  const runId = inserted.rows[0]?.id;
  if (runId === undefined) throw new Error("compaction run insert returned no row");
  const model = await compactionModel(host, tx, teamId, thread, runId);
  if (model.config === undefined) throw new CompactionError("model_not_configured");
  await tx.execute(sql`
    UPDATE threads SET status = 'running', last_activity_at = now()
     WHERE team_id = ${teamId} AND id = ${thread.id}`);
  await appendRunEventsInTx(tx, teamId, runId, [
    {
      type: "run.started",
      payload: {
        thread_id: thread.id,
        agent_id: null,
        agent_version: null,
        model: model.config.alias,
        model_source: model.source,
      },
    },
  ]);
  return { runId, thread, model: model.config, limits: model.limits };
}

/**
 * The model the thread's next turn would use (KOBE-44: the agent's pin, else the conversation's
 * choice, else the team default), so the summary is written by the conversation's model. An agent
 * that does not resolve does not block a compaction: the conversation's choice applies.
 */
async function compactionModel(
  host: CompactionHost,
  tx: KobeTx,
  teamId: string,
  thread: ThreadRow,
  runId: string,
): Promise<{
  readonly config: RunModelConfig | undefined;
  readonly limits: CatalogTokenLimits | undefined;
  readonly source: string;
}> {
  const run = await getRunRow(tx, teamId, runId);
  const resolved = run ? await resolveForStart(tx, host.agents, thread, run) : undefined;
  const requested =
    resolved?.ok === true
      ? requestedModel(thread, resolved)
      : thread.modelAlias !== null
        ? { alias: thread.modelAlias, source: "thread" as const }
        : { alias: undefined, source: "default" as const };
  const resolution = await resolveRunModel(tx, teamId, requested.alias);
  if (!resolution.ok) return { config: undefined, limits: undefined, source: requested.source };
  return { config: resolution.model, limits: resolution.limits, source: requested.source };
}

function parseResult(threadId: string, data: unknown): CompactThreadResponse | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const parsed = compactThreadResponseSchema.safeParse({ ...data, thread_id: threadId });
  return parsed.success ? parsed.data : undefined;
}

/** How the compaction ended for the audit: Stop and budget stops by their run status. */
function auditOutcome(
  status: string | undefined,
  code: CompactThreadErrorCode | undefined,
): CompactThreadErrorCode | "completed" | "cancelled" | "budget_stopped" {
  if (status === "cancelled" || status === "budget_stopped") return status;
  return code ?? "completed";
}

function httpCode(outcome: Extract<CommandOutcome, { ok: false }>): CompactThreadErrorCode {
  return HTTP_CODE[outcome.error.code] ?? "compaction_failed";
}

/**
 * The run ends here unless the delivering replica already ended it (it does on every answer from
 * the sandbox): a command that never reached the sandbox, timed out or lost its connection. A run
 * still leased may be summarizing in Pi: it is aborted (durably, like Stop). Then the audit row.
 */
async function finish(
  host: CompactionHost,
  actor: ActorContext,
  started: Started,
  code: CompactThreadErrorCode | undefined,
  focused: boolean,
): Promise<void> {
  const teamId = actor.team_id;
  const { runId, thread } = started;
  const out = await withAppendTx(host.db, teamId, async (tx) => {
    const end =
      code === undefined
        ? ({ status: "completed" } as const)
        : ({ status: "failed", error: failureInfo(code, "start_failed") } as const);
    const { ended } = await endRunInTx(tx, teamId, runId, end);
    const lease = await tx.execute(sql`
      SELECT 1 FROM sandbox_run_leases WHERE team_id = ${teamId} AND run_id = ${runId}`);
    const abort = ended && code !== undefined && lease.rows.length > 0;
    if (abort) await requestStop(tx, teamId, runId, "abort");
    await recordAudit(tx, {
      action: "thread.compacted",
      actor: { kind: "user", id: actor.user_id },
      teamId,
      target: {
        threadId: thread.id,
        runId,
        outcome: auditOutcome((await getRunRow(tx, teamId, runId))?.status, code),
        focused,
      },
    });
    return { ended, abort };
  });
  if (out.abort) {
    host.abort({ teamId, ownerUserId: thread.ownerUserId, runId, threadId: thread.id });
  }
  if (out.ended) await host.ended(teamId, runId, thread.id);
}
