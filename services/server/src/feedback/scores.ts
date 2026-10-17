import { runTraceId } from "@kobe/protocol";
import type { ScoreSink, TraceScore } from "@kobe/telemetry";
import { and, answerFeedback, eq, withTeam, type KobeDb } from "@kobe/db";
import { logger } from "../logger.js";

/** Name of the score a rating becomes on its run's trace. */
export const FEEDBACK_SCORE_NAME = "answer_feedback";
/** Ratings waiting to be exported at most; past it new ones are dropped (and logged). */
export const FEEDBACK_SCORE_MAX_PENDING = 1000;

export interface FeedbackScoreOptions {
  readonly db: KobeDb;
  readonly sink: ScoreSink;
  /** `telemetry.captureContent`: only then does a score carry the comment. */
  readonly captureContent: boolean;
  readonly maxPending?: number;
}

type ScoreRow = {
  readonly id: string;
  readonly runId: string;
  readonly threadId: string;
  readonly rating: "up" | "down";
  readonly reasons: readonly string[];
  readonly comment: string | null;
  readonly agentScope: string | null;
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  readonly modelAlias: string | null;
};

/** The score for a stored rating: value, reason codes and ids; the comment only with capture on. */
export function scoreOf(teamId: string, row: ScoreRow, captureContent: boolean): TraceScore {
  return {
    id: row.id,
    traceId: runTraceId(row.runId),
    name: FEEDBACK_SCORE_NAME,
    dataType: "BOOLEAN",
    value: row.rating === "up" ? 1 : 0,
    ...(captureContent && row.comment !== null ? { comment: row.comment } : {}),
    metadata: {
      rating: row.rating,
      reasons: [...row.reasons],
      team_id: teamId,
      thread_id: row.threadId,
      run_id: row.runId,
      agent_scope: row.agentScope,
      agent_id: row.agentId,
      agent_version: row.agentVersion,
      model: row.modelAlias,
    },
  };
}

/**
 * Exports ratings as Langfuse scores on their run's trace (KOBE-275), off the request path. A
 * change only names the rating (team, id); the worker reads its current row and upserts the score,
 * or deletes it when the row is gone. So the export is idempotent and order-free: a burst of
 * changes to one rating coalesces into one call with the latest state, and replicas racing on the
 * same rating converge on what the database holds. One call at a time; a failure is logged with
 * the ids and dropped (the next change of that rating sends it again).
 */
export class FeedbackScores {
  readonly #options: FeedbackScoreOptions;
  readonly #pending = new Map<string, string>();
  #worker: Promise<void> | undefined;

  constructor(options: FeedbackScoreOptions) {
    this.#options = options;
  }

  /** Schedules the export of rating `feedbackId` (after its transaction committed). */
  enqueue(teamId: string, feedbackId: string): void {
    const max = this.#options.maxPending ?? FEEDBACK_SCORE_MAX_PENDING;
    if (!this.#pending.has(feedbackId) && this.#pending.size >= max) {
      logger.warn({ teamId, feedbackId }, "answer feedback score dropped: export queue full");
      return;
    }
    this.#pending.set(feedbackId, teamId);
    this.#worker ??= this.#drain().finally(() => {
      this.#worker = undefined;
    });
  }

  /** Resolves once nothing is pending (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#worker) await this.#worker;
  }

  async #drain(): Promise<void> {
    for (;;) {
      const next = this.#pending.entries().next();
      if (next.done) return;
      const [feedbackId, teamId] = next.value;
      this.#pending.delete(feedbackId);
      try {
        await this.#export(teamId, feedbackId);
      } catch (err) {
        logger.warn(
          { teamId, feedbackId, err: { type: (err as Error | undefined)?.name ?? "Error" } },
          "answer feedback score export failed",
        );
      }
    }
  }

  async #export(teamId: string, feedbackId: string): Promise<void> {
    const { db, sink, captureContent } = this.#options;
    const [row] = await withTeam(db, teamId, (tx) =>
      tx
        .select({
          id: answerFeedback.id,
          runId: answerFeedback.runId,
          threadId: answerFeedback.threadId,
          rating: answerFeedback.rating,
          reasons: answerFeedback.reasons,
          comment: answerFeedback.comment,
          agentScope: answerFeedback.agentScope,
          agentId: answerFeedback.agentId,
          agentVersion: answerFeedback.agentVersion,
          modelAlias: answerFeedback.modelAlias,
        })
        .from(answerFeedback)
        .where(and(eq(answerFeedback.teamId, teamId), eq(answerFeedback.id, feedbackId))),
    );
    if (row) await sink.upsert(scoreOf(teamId, row, captureContent));
    else await sink.remove(feedbackId);
  }
}
