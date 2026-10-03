import { isActiveRunStatus } from "@kobe/protocol";
import { scanTeams, sql, withTeam } from "@kobe/db";
import { withAppendTx } from "../event-stream/append.js";
import {
  applyTransition,
  clearStop,
  lockRunRow,
  lockThreadRow,
  requestStop,
  type AppliedTransition,
} from "../runs/store.js";
import type { ApprovalContext } from "./context.js";
import {
  auditExpiredApprovals,
  expireRunApprovalsInTx,
  voidUndeliveredAllowInTx,
  type ExpiredApproval,
} from "./run-end.js";
import { loadApproval, otherPendingCount } from "./store.js";

/** What the `run.failed` of a TTL expiry says (D29: "the run ends visibly"). */
export const APPROVAL_EXPIRED_MESSAGE =
  "The approval request expired after 1 hour without an answer, so the tool call was denied " +
  "and the run ended.";

interface EndedRun {
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly ownerUserId: string;
}

/**
 * TTL expiry (D29): the approval becomes `expired` (cause `ttl`), the call is denied, and the run
 * ends visibly — `waiting_approval → failed` (`approval_expired`) with `run.failed`, a durable
 * abort for Pi (`runs.stop_mode`, re-sent by the orchestrator's sweep if this replica dies), and the
 * thread's queue advances. Idempotent: a row that is no longer pending (or not yet due) is left
 * alone. Returns whether this call expired it.
 */
export async function expireByTtl(
  ctx: ApprovalContext,
  teamId: string,
  approvalId: string,
): Promise<boolean> {
  const head = await withTeam(ctx.db, teamId, (tx) => loadApproval(tx, teamId, approvalId));
  if (!head || head.status !== "pending" || ctx.now() < head.expiresAt) return false;
  const result = await withAppendTx(ctx.db, teamId, async (tx) => {
    const thread = await lockThreadRow(tx, teamId, head.threadId);
    const run = await lockRunRow(tx, teamId, head.runId);
    const row = await loadApproval(tx, teamId, approvalId, { lock: true });
    if (!thread || !run || row?.status !== "pending" || ctx.now() < row.expiresAt) {
      return undefined;
    }
    const expired = await expireRunApprovalsInTx(tx, teamId, run.id, "ttl", approvalId);
    let ended: EndedRun | undefined;
    if (isActiveRunStatus(run.status)) {
      // applyTransition expires the run's other pending approvals (cause ttl) and audits them.
      // `approval_expired` leaves `waiting_approval`; a run found `running` (state repaired by
      // hand, or resumed) still ends, as an error, so the expiry can never be stuck.
      const cause = run.status === "waiting_approval" ? "approval_expired" : "error";
      await applyTransition(tx, thread, run, "failed", cause, {
        type: "run.failed",
        payload: { error: { code: "approval_expired", message: APPROVAL_EXPIRED_MESSAGE } },
      });
      await requestStop(tx, teamId, run.id, "abort");
      ended = { teamId, runId: run.id, threadId: thread.id, ownerUserId: thread.ownerUserId };
    }
    await auditExpiredApprovals(tx, teamId, expired);
    return { expired, ended };
  });
  if (!result) return false;
  if (result.ended) await stopAndAdvance(ctx, result.ended);
  return result.expired.length > 0;
}

/** Abort Pi's run (best effort; the orchestrator's sweep re-sends a stop left in `stop_mode`). */
async function stopAndAdvance(ctx: ApprovalContext, run: EndedRun): Promise<void> {
  const target = { teamId: run.teamId, userId: run.ownerUserId };
  const { router, onRunEnded } = ctx.hooks;
  try {
    if (router && (await router.isConnected(target))) {
      const outcome = await router.stopRun(target, {
        runId: run.runId,
        threadId: run.threadId,
        mode: "abort",
        reason: "approval_expired",
      });
      if (outcome.ok) {
        await withAppendTx(ctx.db, run.teamId, (tx) =>
          clearStop(tx, run.teamId, run.runId, "abort"),
        );
      }
    }
  } catch (err) {
    ctx.log.warn({ err, run_id: run.runId }, "could not stop the run of an expired approval");
  }
  try {
    await onRunEnded?.({ teamId: run.teamId, runId: run.runId, threadId: run.threadId });
  } catch (err) {
    ctx.log.error({ err, run_id: run.runId }, "run-ended hook failed after an approval expiry");
  }
}

/**
 * The sandbox connection that asked went away before a decision reached it (the agent denies the
 * waiting call itself). The approval can no longer be used: a pending one is `expired` (cause
 * `run_interrupted`); one allowed but not delivered is voided the same way
 * (`voidUndeliveredAllowInTx`). The run goes back to `running` when nothing else waits — it
 * resumes on the sandbox's reconnect, or the wire interrupts it.
 */
export async function expireAborted(
  ctx: ApprovalContext,
  teamId: string,
  approvalId: string,
): Promise<AppliedTransition | undefined> {
  const head = await withTeam(ctx.db, teamId, (tx) => loadApproval(tx, teamId, approvalId));
  if (head?.status !== "pending" && head?.status !== "allowed") return undefined;
  return withAppendTx(ctx.db, teamId, async (tx) => {
    const thread = await lockThreadRow(tx, teamId, head.threadId);
    const run = await lockRunRow(tx, teamId, head.runId);
    if (!thread || !run) return undefined;
    // Pending: nobody can deliver a decision any more. Allowed but not delivered: void it.
    const expired = [
      ...(await expireRunApprovalsInTx(tx, teamId, run.id, "run_interrupted", approvalId)),
      ...(await voidUndeliveredAllowInTx(tx, teamId, approvalId)),
    ];
    const resumed = await resumeIfNoneWaiting(tx, thread, run, approvalId, expired);
    await auditExpiredApprovals(tx, teamId, expired);
    return resumed;
  });
}

/** `waiting_approval → running` once the run's last pending approval is resolved. */
export async function resumeIfNoneWaiting(
  tx: Parameters<typeof applyTransition>[0],
  thread: Parameters<typeof applyTransition>[1],
  run: Parameters<typeof applyTransition>[2],
  approvalId: string,
  resolved: readonly ExpiredApproval[] | true,
): Promise<AppliedTransition | undefined> {
  if (resolved !== true && resolved.length === 0) return undefined;
  if (run.status !== "waiting_approval") return undefined;
  if ((await otherPendingCount(tx, run.teamId, run.id, approvalId)) > 0) return undefined;
  return (await applyTransition(tx, thread, run, "running", "approval_resolved", undefined))
    .transition;
}

/**
 * Backstop for TTL expiry when no broker is waiting (its replica died): every team's overdue
 * pending approvals, `graceMs` past their expiry so the waiting replica's own timer goes first.
 * Returns how many were expired.
 */
export async function sweepExpired(ctx: ApprovalContext, graceMs: number): Promise<number> {
  const due = await scanTeams(ctx.db, "approval expiry sweep", async (tx, team) => {
    const res = await tx.execute<{ id: string }>(sql`
      SELECT id FROM approvals
       WHERE team_id = ${team.id} AND status = 'pending'
         AND expires_at < ${new Date(ctx.now().getTime() - graceMs).toISOString()}
       ORDER BY expires_at LIMIT 100`);
    return res.rows.length > 0 ? { teamId: team.id, ids: res.rows.map((r) => r.id) } : undefined;
  });
  let expired = 0;
  for (const team of due) {
    for (const id of team.ids) {
      try {
        if (await expireByTtl(ctx, team.teamId, id)) expired += 1;
      } catch (err) {
        ctx.log.error({ err, approval_id: id }, "approval expiry failed");
      }
    }
  }
  return expired;
}
