import {
  BRANCH_SUMMARIES_MAX,
  isActiveRunStatus,
  type ActorContext,
  type BranchSummaryErrorCode,
  type BranchSummaryResponse,
} from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { effectiveModelLimits } from "../models/token-limits.js";
import { parseBranchSummaryResult } from "../sandbox-wire/branch-summary-end.js";
import { piSessionEntrySql, treeEntrySql } from "../sandbox-wire/entries.js";
import { endRunInTx } from "../sandbox-wire/run-state.js";
import type { CommandOutcome } from "../sandbox-wire/types.js";
import type { Viewer } from "../threads/repository.js";
import { lockOwnedThread } from "./access.js";
import { compactionModel, type CompactionHost } from "./compaction.js";
import { failureInfo } from "./failure-codes.js";
import type { RunModelConfig } from "./models.js";
import { getRunRow, requestStop, threadRunRows, type ThreadRow } from "./store.js";
import type { CatalogTokenLimits } from "../models/token-limits.js";

/**
 * Make it current and carry a summary (KOBE-548, docs/specs/conversation-tree.md CT11): a run of
 * kind `branch_summary`, created running under the thread lock exactly as a compaction is
 * (`runs/compaction.ts`): busy or queued → `thread_busy`, never queued, budgeted, leased and
 * audited. Its `thread.branch_summary` goes only to agents with `thread_branch_summary`; Pi
 * summarises the branch left and appends a `branch_summary` entry under the target. The
 * delivering replica mirrors it, makes it the leaf, emits `thread.updated {leaf_entry_id}` and
 * ends the run; this requester answers the member. Pi owns the text; the sandbox's is logged only.
 */
export class BranchSummaryError extends Error {
  constructor(readonly code: BranchSummaryErrorCode | "entry_not_found") {
    super(code);
    this.name = "BranchSummaryError";
  }
}

/** What the orchestrator lends a branch summary: a compaction's host. */
export type BranchSummaryHost = CompactionHost;

interface Started {
  readonly runId: string;
  readonly thread: ThreadRow;
  readonly fromLeafEntryId: string;
  readonly model: RunModelConfig;
  readonly limits: CatalogTokenLimits | undefined;
}

/** The codes a started run can end with (the rest are refused before it exists). */
type RunEndCode = Extract<
  BranchSummaryErrorCode,
  | "thread_busy"
  | "sandbox_unavailable"
  | "nothing_to_summarize"
  | "model_not_configured"
  | "summary_failed"
>;

/** Sandbox and wire codes as the member sees them; anything else is `summary_failed`. */
const HTTP_CODE: Readonly<Record<string, RunEndCode>> = {
  thread_busy: "thread_busy",
  nothing_to_summarize: "nothing_to_summarize",
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

export async function summarizeBranch(
  host: BranchSummaryHost,
  actor: ActorContext,
  threadId: string,
  toEntryId: string,
  focus: string | undefined,
): Promise<BranchSummaryResponse> {
  const started = await host.threadTx(actor, (tx, viewer) =>
    startInTx(host, tx, viewer, actor, threadId, toEntryId),
  );
  const { runId, thread } = started;
  const outcome = await host.router
    .branchSummary(
      { teamId: actor.team_id, userId: thread.ownerUserId },
      {
        runId,
        threadId: thread.id,
        fromLeafEntryId: started.fromLeafEntryId,
        toEntryId,
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
  if (!outcome.ok) {
    // The sandbox's text is untrusted: logged (capped), never answered.
    host.log.warn(
      { run_id: runId, code: outcome.error.code, error: outcome.error.message.slice(0, 300) },
      "branch summary failed",
    );
  }
  const code = outcome.ok ? undefined : (HTTP_CODE[outcome.error.code] ?? "summary_failed");
  const reported = outcome.ok ? parseBranchSummaryResult(outcome.data) : undefined;
  const result = await finish(host, actor, started, code, reported?.entry_id, focus !== undefined);
  if (result.code !== undefined || reported === undefined) {
    throw new BranchSummaryError(result.code ?? "summary_failed");
  }
  return { thread_id: thread.id, entry_id: reported.entry_id, leaf_entry_id: reported.entry_id };
}

/**
 * The owner's thread, locked (`lockOwnedThread`: 404, reader `read_only`, Trash); builder test,
 * Workbench and eval threads refused `test_thread` (CT19).
 */
async function lockForSummary(tx: KobeTx, viewer: Viewer, threadId: string): Promise<ThreadRow> {
  const thread = await lockOwnedThread(tx, viewer, threadId, "thread_not_found");
  const test = await tx.execute<{ is_test: boolean }>(sql`
    SELECT is_test FROM threads WHERE team_id = ${viewer.teamId} AND id = ${threadId}`);
  if (test.rows[0]?.is_test === true || thread.skillTest === true || thread.skillEval === true) {
    throw new BranchSummaryError("test_thread");
  }
  return thread;
}

/**
 * The target must be a tree node Pi's session has; the old leaf is the thread's leaf, or, when that
 * is a server-written row Pi never had (an app card `ka-`, a kept unsent prompt `ku-`), its nearest
 * ancestor Pi has (as `withoutAppCards` does for `run.start`). Null: no such entry.
 */
async function checkTarget(
  tx: KobeTx,
  teamId: string,
  thread: ThreadRow,
  toEntryId: string,
): Promise<string | null> {
  const target = await tx.execute(sql`
    SELECT 1 FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${thread.id} AND entry_id = ${toEntryId}
       AND ${piSessionEntrySql} AND ${treeEntrySql()}`);
  if (target.rows.length === 0) throw new BranchSummaryError("entry_not_found");
  if (thread.leafEntryId === null) return null;
  const pi = sql`(${piSessionEntrySql} AND ${treeEntrySql()})`;
  const from = await tx.execute<{ entry_id: string }>(sql`
    WITH RECURSIVE up AS (
      SELECT s.entry_id, s.parent_id, s.pi, 0 AS depth FROM (
        SELECT entry_id, parent_id, ${pi} AS pi FROM thread_entries
         WHERE team_id = ${teamId} AND thread_id = ${thread.id}
           AND entry_id = ${thread.leafEntryId}) s
      UNION ALL
      SELECT s.entry_id, s.parent_id, s.pi, up.depth + 1 FROM up CROSS JOIN LATERAL (
        SELECT entry_id, parent_id, ${pi} AS pi FROM thread_entries
         WHERE team_id = ${teamId} AND thread_id = ${thread.id}
           AND entry_id = up.parent_id) s
       WHERE NOT up.pi AND up.depth < 1000
    )
    SELECT entry_id FROM up WHERE pi ORDER BY depth LIMIT 1`);
  return from.rows[0]?.entry_id ?? null;
}

async function startInTx(
  host: BranchSummaryHost,
  tx: KobeTx,
  viewer: Viewer,
  actor: ActorContext,
  threadId: string,
  toEntryId: string,
): Promise<Started> {
  const teamId = actor.team_id;
  const thread = await lockForSummary(tx, viewer, threadId);
  await host.assertMayRun(tx, actor);
  // Only an idle thread: any run (running, waiting, queued) holds it; never queued itself.
  const active = (await threadRunRows(tx, teamId, thread.id)).some((r) =>
    isActiveRunStatus(r.status),
  );
  if (active || thread.status !== "idle") throw new BranchSummaryError("thread_busy");
  const from = await checkTarget(tx, teamId, thread, toEntryId);
  if (from === null || from === toEntryId) throw new BranchSummaryError("nothing_to_summarize");
  const held = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM thread_entries
       WHERE team_id = ${teamId} AND thread_id = ${thread.id} AND type = 'branch_summary'
       LIMIT ${BRANCH_SUMMARIES_MAX}) s`);
  if ((held.rows[0]?.n ?? 0) >= BRANCH_SUMMARIES_MAX) {
    throw new BranchSummaryError("summary_limit");
  }
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO runs (team_id, thread_id, trigger, kind, status, started_at)
    VALUES (${teamId}, ${thread.id}, 'user', 'branch_summary', 'running', now())
    RETURNING id`);
  const runId = inserted.rows[0]?.id;
  if (runId === undefined) throw new Error("branch summary run insert returned no row");
  const model = await compactionModel(host, tx, teamId, thread, runId);
  if (model.config === undefined) throw new BranchSummaryError("model_not_configured");
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
  return { runId, thread, fromLeafEntryId: from, model: model.config, limits: model.limits };
}

type AuditOutcome = RunEndCode | "completed" | "cancelled" | "budget_stopped";

/** How the run ended for the audit: Stop and budget stops by their run status. */
function auditOutcome(status: string | undefined, code: RunEndCode | undefined): AuditOutcome {
  if (status === "cancelled" || status === "budget_stopped") return status;
  return code ?? "completed";
}

/**
 * The run ends here unless the delivering replica already ended it (it does on every answer): a
 * command that never reached the sandbox, timed out or lost its connection. A run still leased may
 * be summarising in Pi: it is aborted (durably, like Stop). A success counts when the thread's leaf
 * is the reported summary (the delivery set it), even if Stop or the sweep closed the run first:
 * Pi's session is on the summary (review M2). Then the audit row.
 */
async function finish(
  host: BranchSummaryHost,
  actor: ActorContext,
  started: Started,
  answered: RunEndCode | undefined,
  reportedEntryId: string | undefined,
  focused: boolean,
): Promise<{ readonly code: RunEndCode | undefined }> {
  const teamId = actor.team_id;
  const { runId, thread } = started;
  const out = await withAppendTx(host.db, teamId, async (tx) => {
    // This end only lands when the delivery did not end the run (it does on every answer, and on a
    // success it completed it): then the summary never landed.
    const end = {
      status: "failed",
      error: failureInfo(answered ?? "summary_failed", "start_failed"),
    } as const;
    const { ended } = await endRunInTx(tx, teamId, runId, end);
    const run = await getRunRow(tx, teamId, runId);
    // The leaf is the reported entry and it is a summary (never an old leaf a sandbox named).
    const leaf = await tx.execute<{ leaf_entry_id: string | null; type: string | null }>(sql`
      SELECT t.leaf_entry_id, e.type FROM threads t
        LEFT JOIN thread_entries e
          ON e.team_id = t.team_id AND e.thread_id = t.id AND e.entry_id = t.leaf_entry_id
       WHERE t.team_id = ${teamId} AND t.id = ${thread.id}`);
    const leafId = leaf.rows[0]?.leaf_entry_id ?? null;
    const landed =
      reportedEntryId !== undefined &&
      leafId === reportedEntryId &&
      leaf.rows[0]?.type === "branch_summary";
    const code: RunEndCode | undefined = answered ?? (landed ? undefined : "summary_failed");
    const lease = await tx.execute(sql`
      SELECT 1 FROM sandbox_run_leases WHERE team_id = ${teamId} AND run_id = ${runId}`);
    const abort = ended && code !== undefined && lease.rows.length > 0;
    if (abort) await requestStop(tx, teamId, runId, "abort");
    const outcome: AuditOutcome =
      landed && code === undefined ? "completed" : auditOutcome(run?.status, code);
    await recordAudit(tx, {
      action: "thread.branch_summarized",
      actor: { kind: "user", id: actor.user_id },
      teamId,
      target: { threadId: thread.id, runId, outcome, focused },
    });
    return { ended, abort, code };
  });
  if (out.abort) {
    host.abort({ teamId, ownerUserId: thread.ownerUserId, runId, threadId: thread.id });
  }
  if (out.ended) await host.ended(teamId, runId, thread.id);
  return { code: out.code };
}
