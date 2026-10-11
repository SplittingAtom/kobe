import { isActiveRunStatus, isTerminalRunStatus } from "@kobe/protocol";
import { SYSTEM_ACTOR, sql, withTeam, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { withAppendTx } from "../event-stream/append.js";
import type { StopTarget } from "./dispatch.js";
import { cancelledEvent } from "./lifecycle.js";
import {
  applyTransition,
  lockRunRow,
  lockThreadRow,
  requestStop,
  type AppliedTransition,
} from "./store.js";

/** Why the system cancels a user's scheduled runs (audit `run.cancelled.reason`). */
export type ScheduledCancelReason = "owner_deactivated" | "member_removed";

export interface CancelScheduledContext {
  readonly db: KobeDb;
  /** Retries on a busy thread row (lock timeout), like the orchestrator's own entry points. */
  readonly withRetry: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly emit: (teamId: string, transitions: readonly AppliedTransition[]) => void;
  /** Sends Pi the abort and then advances the thread's queue (in the background). */
  readonly stopThenAdvance: (target: StopTarget) => void;
}

/**
 * Cancels the in-flight scheduled runs (`trigger = schedule`; queued, running or waiting for an
 * approval) of `userId` in one team (KOBE-180, D7/D32): the owner was deactivated or left the team,
 * so nothing they scheduled may keep working. Interactive runs are left to the sandbox teardown.
 * Each run ends like a Stop (`cancelled`, abort requested durably so the sweep re-sends it) and is
 * audited as the system. Returns the cancelled run ids.
 */
export async function cancelScheduledRuns(
  ctx: CancelScheduledContext,
  teamId: string,
  userId: string,
  reason: ScheduledCancelReason,
): Promise<readonly string[]> {
  const candidates = await withTeam(ctx.db, teamId, async (tx) => {
    const res = await tx.execute<{ id: string; thread_id: string }>(sql`
      SELECT r.id, r.thread_id
        FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${teamId} AND t.team_id = ${teamId}
         AND t.owner_user_id = ${userId} AND r.trigger = 'schedule'
         AND r.status IN ('queued', 'running', 'waiting_approval')
       ORDER BY r.status <> 'queued'`);
    return res.rows;
  });
  const cancelled: string[] = [];
  for (const c of candidates) {
    const outcome = await ctx.withRetry(() =>
      withAppendTx(ctx.db, teamId, async (tx) => {
        const thread = await lockThreadRow(tx, teamId, c.thread_id);
        const run = await lockRunRow(tx, teamId, c.id);
        if (!thread || !run || isTerminalRunStatus(run.status)) return undefined;
        const wasActive = isActiveRunStatus(run.status);
        const applied = await applyTransition(
          tx,
          thread,
          run,
          "cancelled",
          "user_cancelled",
          cancelledEvent(thread),
        );
        if (wasActive) await requestStop(tx, teamId, run.id, "abort");
        await recordAudit(tx, {
          action: "run.cancelled",
          actor: SYSTEM_ACTOR,
          teamId,
          target: { runId: run.id, threadId: thread.id, wasActive, reason },
        });
        return { transition: applied.transition, wasActive };
      }),
    );
    if (!outcome) continue;
    cancelled.push(c.id);
    if (outcome.transition) ctx.emit(teamId, [outcome.transition]);
    if (outcome.wasActive) {
      ctx.stopThenAdvance({ teamId, ownerUserId: userId, runId: c.id, threadId: c.thread_id });
    }
  }
  return cancelled;
}
