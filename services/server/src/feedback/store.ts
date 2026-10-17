import type { AnswerFeedback, PutFeedbackBody, ThreadFeedback } from "@kobe/protocol";
import {
  ANSWER_FEEDBACK_MODEL_MAX_CHARS,
  agentEvalCases,
  and,
  answerFeedback,
  asc,
  eq,
  isNotNull,
  runs,
  sql,
  threadEntries,
  type AgentScope,
  type KobeTx,
} from "@kobe/db";
import { caseCutoff, liveCase } from "../eval-cases/visibility.js";
import { findThread, type SummaryRow, type Viewer } from "../threads/repository.js";

/**
 * Answer feedback data access (KOBE-275). Runs inside the caller's `withTeam` transaction (RLS
 * confines it to the team) and repeats `team_id` in every predicate. Who may rate: whoever may read
 * the thread (`findThread`: its owner, and readers of a project- or team-shared thread), each for
 * themselves. Every read and write is keyed on the caller's user id, so nobody reads or changes
 * another member's rating through here.
 */

export type FeedbackError =
  | "run_not_found"
  | "thread_not_found"
  | "entry_not_found"
  | "run_not_ended"
  | "not_an_answer"
  | "thread_in_trash"
  | "test_thread";

export type FeedbackResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: FeedbackError };

const fail = (error: FeedbackError): { ok: false; error: FeedbackError } => ({ ok: false, error });

const feedbackColumns = {
  id: answerFeedback.id,
  runId: answerFeedback.runId,
  threadId: answerFeedback.threadId,
  entryId: answerFeedback.entryId,
  rating: answerFeedback.rating,
  reasons: answerFeedback.reasons,
  comment: answerFeedback.comment,
  updatedAt: answerFeedback.updatedAt,
};

export type FeedbackRow = {
  readonly id: string;
  readonly runId: string;
  readonly threadId: string;
  readonly entryId: string | null;
  readonly rating: AnswerFeedback["rating"];
  readonly reasons: AnswerFeedback["reasons"];
  readonly comment: string | null;
  readonly updatedAt: Date;
};

export function toAnswerFeedback(row: FeedbackRow): AnswerFeedback {
  return {
    run_id: row.runId,
    thread_id: row.threadId,
    entry_id: row.entryId,
    rating: row.rating,
    reasons: [...row.reasons],
    comment: row.comment,
    updated_at: row.updatedAt.toISOString(),
  };
}

/** A thread that takes ratings: not in Trash, not a builder's test thread (KOBE-85). */
function rateable(thread: SummaryRow): FeedbackError | null {
  if (thread.isTest) return "test_thread";
  if (thread.deletedAt !== null) return "thread_in_trash";
  return null;
}

type RunHead = {
  readonly id: string;
  readonly threadId: string;
  readonly kind: string;
  readonly endedAt: Date | null;
};

/** The ended message run `runId` on a thread the viewer may read and rate, or why not. */
async function rateableRun(
  tx: KobeTx,
  viewer: Viewer,
  runId: string,
): Promise<FeedbackResult<{ run: RunHead; thread: SummaryRow }>> {
  const [run] = await tx
    .select({ id: runs.id, threadId: runs.threadId, kind: runs.kind, endedAt: runs.endedAt })
    .from(runs)
    .where(and(eq(runs.teamId, viewer.teamId), eq(runs.id, runId)));
  if (!run) return fail("run_not_found");
  // Unknown run, another team's, or a thread the viewer can't read: all the same 404.
  const found = await findThread(tx, viewer, run.threadId);
  if (!found) return fail("run_not_found");
  const refused = rateable(found.thread);
  if (refused) return fail(refused);
  if (run.kind !== "message") return fail("not_an_answer");
  if (run.endedAt === null) return fail("run_not_ended");
  return { ok: true, value: { run, thread: found.thread } };
}

interface AgentSnapshot {
  readonly agentScope: AgentScope | null;
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  readonly modelAlias: string | null;
}

const NO_AGENT: AgentSnapshot = {
  agentScope: null,
  agentId: null,
  agentVersion: null,
  modelAlias: null,
};

/**
 * The agent version and model the run used: its `run.started` event (agent id, published version,
 * catalog alias), or the thread's pin once the event was compacted (D18, 7 days after the run;
 * the model is then unknown). The scope is the thread's: a thread keeps its agent.
 */
async function agentSnapshot(
  tx: KobeTx,
  teamId: string,
  runId: string,
  thread: SummaryRow,
): Promise<AgentSnapshot> {
  const started = await tx.execute<{
    agent_id: string | null;
    agent_version: number | null;
    model: string | null;
  }>(sql`
    SELECT payload ->> 'agent_id' AS agent_id,
           (payload ->> 'agent_version')::int AS agent_version,
           payload ->> 'model' AS model
      FROM run_events
     WHERE team_id = ${teamId} AND run_id = ${runId} AND type = 'run.started'
     ORDER BY seq LIMIT 1`);
  const event = started.rows[0];
  const pinned =
    thread.agentScope !== null && thread.agentId !== null
      ? { agentScope: thread.agentScope, agentId: thread.agentId }
      : null;
  if (!event) {
    return pinned ? { ...pinned, agentVersion: thread.agentVersion, modelAlias: null } : NO_AGENT;
  }
  const model =
    event.model !== null &&
    event.model.length >= 1 &&
    event.model.length <= ANSWER_FEEDBACK_MODEL_MAX_CHARS
      ? event.model
      : null;
  if (event.agent_id === null || pinned === null || pinned.agentId !== event.agent_id) {
    return { ...NO_AGENT, modelAlias: model };
  }
  const version =
    event.agent_version !== null && event.agent_version > 0 ? event.agent_version : null;
  return { ...pinned, agentVersion: version, modelAlias: model };
}

/**
 * Rates an answer for the viewer, or changes their rating (one per run and member). The agent
 * snapshot is taken on the first rating and kept by changes. `entry_id`, when given, must be an
 * entry of the run's thread; a change without one keeps the stored entry.
 */
export async function rateAnswer(
  tx: KobeTx,
  viewer: Viewer,
  runId: string,
  body: PutFeedbackBody,
): Promise<FeedbackResult<FeedbackRow>> {
  const found = await rateableRun(tx, viewer, runId);
  if (!found.ok) return found;
  const { run, thread } = found.value;
  if (body.entry_id !== null) {
    const [entry] = await tx
      .select({ one: sql<number>`1` })
      .from(threadEntries)
      .where(
        and(
          eq(threadEntries.teamId, viewer.teamId),
          eq(threadEntries.threadId, run.threadId),
          eq(threadEntries.entryId, body.entry_id),
        ),
      );
    if (!entry) return fail("entry_not_found");
  }
  const snapshot = await agentSnapshot(tx, viewer.teamId, run.id, thread);
  const [row] = await tx
    .insert(answerFeedback)
    .values({
      teamId: viewer.teamId,
      threadId: run.threadId,
      runId: run.id,
      entryId: body.entry_id,
      userId: viewer.userId,
      rating: body.rating,
      reasons: [...body.reasons],
      comment: body.comment,
      ...snapshot,
    })
    .onConflictDoUpdate({
      target: [answerFeedback.teamId, answerFeedback.runId, answerFeedback.userId],
      set: {
        rating: body.rating,
        reasons: [...body.reasons],
        comment: body.comment,
        entryId: sql`COALESCE(excluded.entry_id, ${answerFeedback.entryId})`,
        updatedAt: sql`now()`,
      },
    })
    .returning(feedbackColumns);
  if (!row) throw new Error("answer feedback upsert returned nothing");
  return { ok: true, value: row };
}

/**
 * Clears the viewer's rating of a run: their own row only, whether or not they can still read the
 * thread (a reader whose share ended can still take back what they wrote). Idempotent; returns the
 * cleared rating's id, or null when there was none.
 */
export async function clearRating(
  tx: KobeTx,
  viewer: Viewer,
  runId: string,
): Promise<string | null> {
  const [row] = await tx
    .delete(answerFeedback)
    .where(
      and(
        eq(answerFeedback.teamId, viewer.teamId),
        eq(answerFeedback.runId, runId),
        eq(answerFeedback.userId, viewer.userId),
      ),
    )
    .returning({ id: answerFeedback.id });
  return row?.id ?? null;
}

/**
 * The thread's rateable answers (ended message runs, oldest first) with the viewer's rating of
 * each. A thread in Trash or a test thread has none.
 */
export async function threadFeedback(
  tx: KobeTx,
  viewer: Viewer,
  threadId: string,
): Promise<FeedbackResult<ThreadFeedback>> {
  const found = await findThread(tx, viewer, threadId);
  if (!found) return fail("thread_not_found");
  if (rateable(found.thread) !== null)
    return { ok: true, value: { thread_id: threadId, answers: [] } };
  const rows = await tx
    .select({
      runId: runs.id,
      userEntryId: runs.userEntryId,
      feedback: feedbackColumns,
      evalCaseId: agentEvalCases.id,
    })
    .from(runs)
    .leftJoin(
      answerFeedback,
      and(
        eq(answerFeedback.teamId, runs.teamId),
        eq(answerFeedback.runId, runs.id),
        eq(answerFeedback.userId, viewer.userId),
      ),
    )
    // The viewer's own case shared from this rating (KOBE-276).
    .leftJoin(
      agentEvalCases,
      and(
        eq(agentEvalCases.teamId, answerFeedback.teamId),
        eq(agentEvalCases.feedbackId, answerFeedback.id),
        eq(agentEvalCases.userId, viewer.userId),
        liveCase(await caseCutoff(tx, viewer.teamId)),
      ),
    )
    .where(
      and(
        eq(runs.teamId, viewer.teamId),
        eq(runs.threadId, threadId),
        eq(runs.kind, "message"),
        isNotNull(runs.endedAt),
      ),
    )
    .orderBy(asc(runs.createdAt), asc(runs.id));
  return {
    ok: true,
    value: {
      thread_id: threadId,
      answers: rows.map((r) => ({
        run_id: r.runId,
        user_entry_id: r.userEntryId,
        feedback: r.feedback ? toAnswerFeedback(r.feedback) : null,
        eval_case_id: r.evalCaseId,
      })),
    },
  };
}
