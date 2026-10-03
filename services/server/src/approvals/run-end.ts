import type { ApprovalResolutionCause, RunTransitionCause } from "@kobe/protocol";
import { SYSTEM_ACTOR, sql, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { appendRunEventsInTx } from "../event-stream/append.js";
import { notifyHintInTx } from "../sandbox-wire/bus.js";

/**
 * Ending a run's pending approvals (D29, D30; KOBE-37). Every path that ends a run calls
 * {@link expireRunApprovalsInTx} inside its own transaction, before the run's terminal event: each
 * pending approval of the run becomes `expired` with the cause, and an `approval.resolved` event is
 * appended, so the card never keeps waiting on a run that is gone. The audit rows are written by
 * {@link auditExpiredApprovals} as the caller's last step (KOBE-15: audit last).
 *
 * Leaf module (database, event append and audit only), so the run store and the sandbox wire can
 * both import it without a cycle.
 */

export type ExpiryCause = Exclude<ApprovalResolutionCause, "user">;

export interface ExpiredApproval {
  readonly approvalId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly cause: ExpiryCause;
}

/** Which approval cause a run transition implies (the run ended while an approval was pending). */
export function expiryCauseOf(cause: RunTransitionCause): ExpiryCause {
  switch (cause) {
    case "approval_expired":
      return "ttl";
    case "user_cancelled":
      return "run_cancelled";
    case "budget_exhausted":
      return "budget_exhausted";
    case "error":
      return "run_failed";
    // sandbox lost, or Pi settled while an approval was orphaned (its waiter's replica died).
    default:
      return "run_interrupted";
  }
}

/**
 * Expires the run's pending approvals (or only `approvalId`) and appends their `approval.resolved`
 * events. The caller holds the thread and run locks; returns what it expired for the audit and
 * for bus hints (the waiting broker re-reads the row).
 */
export async function expireRunApprovalsInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  cause: ExpiryCause,
  approvalId?: string,
): Promise<ExpiredApproval[]> {
  const res = await tx.execute<{ id: string; tool_call_id: string; tool: string }>(sql`
    UPDATE approvals SET status = 'expired', cause = ${cause}, decided_at = now()
     WHERE team_id = ${teamId} AND run_id = ${runId} AND status = 'pending'
       ${approvalId === undefined ? sql`` : sql`AND id = ${approvalId}`}
     RETURNING id, tool_call_id, tool`);
  const expired = res.rows
    .map((r) => ({ approvalId: r.id, runId, toolCallId: r.tool_call_id, tool: r.tool, cause }))
    .sort((a, b) => a.toolCallId.localeCompare(b.toolCallId));
  if (expired.length === 0) return [];
  await appendRunEventsInTx(
    tx,
    teamId,
    runId,
    expired.map((e) => ({
      type: "approval.resolved" as const,
      payload: {
        approval_id: e.approvalId,
        tool_call_id: e.toolCallId,
        decision: "expired" as const,
        cause,
        remembered: false,
      },
    })),
  );
  // Waiting brokers (any replica) re-read their row now instead of at their next poll.
  for (const e of expired) {
    await notifyHintInTx(tx, { kind: "apr", id: e.approvalId });
  }
  return expired;
}

/**
 * The connection that asked closed before an `allow` reached it (KOBE-37 review): the sandbox was
 * told "deny", so the allowed approval must not stay usable. An allowed row is voided — `expired`
 * (`run_interrupted`), its token state cleared — unless an MCP approval was already consumed (then
 * it ran, through the proxy, with exactly the approved input). Appends `approval.resolved` so the
 * card stops saying "Approved". Built-in approvals (marked used at allow) are voided too: the
 * sandbox never ran them.
 */
export async function voidUndeliveredAllowInTx(
  tx: KobeTx,
  teamId: string,
  approvalId: string,
): Promise<ExpiredApproval[]> {
  const res = await tx.execute<{ run_id: string; tool_call_id: string; tool: string }>(sql`
    UPDATE approvals
       SET status = 'expired', cause = 'run_interrupted', decided_at = now(), decided_by = NULL,
           token_kid = NULL, token_expires_at = NULL, input_hmac = NULL, consumed_at = NULL
     WHERE team_id = ${teamId} AND id = ${approvalId} AND status = 'allowed'
       AND (consumed_at IS NULL OR tool NOT LIKE 'mcp\_\_%')
     RETURNING run_id, tool_call_id, tool`);
  const row = res.rows[0];
  if (!row) return [];
  const voided: ExpiredApproval = {
    approvalId,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    tool: row.tool,
    cause: "run_interrupted",
  };
  await appendRunEventsInTx(tx, teamId, row.run_id, [
    {
      type: "approval.resolved",
      payload: {
        approval_id: approvalId,
        tool_call_id: row.tool_call_id,
        decision: "expired",
        cause: "run_interrupted",
        remembered: false,
      },
    },
  ]);
  await notifyHintInTx(tx, { kind: "apr", id: approvalId });
  return [voided];
}

/** One `approval.expired` audit row per expired approval (system). Call as the last step. */
export async function auditExpiredApprovals(
  tx: KobeTx,
  teamId: string,
  expired: readonly ExpiredApproval[],
): Promise<void> {
  for (const e of expired) {
    await recordAudit(tx, {
      action: "approval.expired",
      actor: SYSTEM_ACTOR,
      teamId,
      target: {
        approvalId: e.approvalId,
        runId: e.runId,
        toolCallId: e.toolCallId,
        tool: e.tool,
        cause: e.cause,
      },
    });
  }
}
