import {
  isActiveRunStatus,
  type ActorContext,
  type ApproveAllBody,
  type ToolDescriptor,
} from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { withAppendTx } from "../event-stream/append.js";
import { readTeamRememberLimits } from "../policy/remember-limits-store.js";
import { lockRunRow, lockThreadRow } from "../runs/store.js";
import { ApprovalError, type ApprovalContext } from "./context.js";
import { allowRowInTx, askerConnected, isProjectWrite } from "./decide.js";
import { resumeIfNoneWaiting } from "./expiry.js";
import { auditExpiredApprovals, expireRunApprovalsInTx } from "./run-end.js";
import { loadApproval, type ApprovalRow } from "./store.js";
import { viewOf, type ApprovalView } from "./view.js";

/**
 * Whether a waiting call may be allowed together with others ("Approve all waiting", KOBE-289
 * ac-3): never a destructive or open-world tool (by the server's own descriptor and the stored
 * risk), never one the registry no longer knows, never a write to a project's shared state (D24;
 * review N4). Those are approved one by one.
 */
export function batchable(
  row: Pick<ApprovalRow, "risk" | "tool" | "inputCanonical">,
  tool: ToolDescriptor | undefined,
) {
  return (
    !isProjectWrite(row.tool, JSON.parse(row.inputCanonical) as unknown) &&
    tool !== undefined &&
    tool !== undefined &&
    tool.name === row.tool &&
    row.risk !== "destructive" &&
    tool.risk !== "destructive" &&
    !tool.open_world
  );
}

const notFound = () =>
  new ApprovalError("approval_not_found", 404, "No pending approval with that id.");

function notAllowed(message: string) {
  return new ApprovalError("approve_all_not_allowed", 403, message);
}

/**
 * `POST /v1/approvals/approve-all` (KOBE-289 ac-3): the run's user allows every listed pending
 * approval of one run in one action. Nothing about the decision is shared: each approval is
 * signed over its own (run, tool call, tool, canonical input), marked, announced
 * (`approval.resolved`) and audited (`approval.decided`, `approveAll: true`) on its own, in one
 * transaction that refuses the whole set when any one of them fails a check:
 *
 * - the team's limits allow it (`approve_all`);
 * - every approval is the caller's, of this run, pending, unexpired, and its asking connection
 *   is live (as for one decision; anything else is 404, 409 or `approval_unavailable`);
 * - none is destructive or open-world (`batchable`), so those always get their own decision.
 *
 * No remember-rule is written. Readers of a shared thread are not the run's user: 404.
 */
export async function approveAll(
  ctx: ApprovalContext,
  actor: ActorContext,
  body: ApproveAllBody,
): Promise<ApprovalView[]> {
  const keys = ctx.keys;
  if (!keys) {
    throw new ApprovalError("approvals_unavailable", 503, "Approvals are not configured.");
  }
  const teamId = actor.team_id;
  const heads = await withTeam(ctx.db, teamId, (tx) =>
    Promise.all(body.approval_ids.map((id) => loadApproval(tx, teamId, id))),
  );
  const first = heads[0];
  if (!first) throw notFound();
  for (const head of heads) {
    if (head?.userId !== actor.user_id || head.runId !== body.run_id) throw notFound();
  }
  // The server's descriptors, resolved before the transaction (the registry reads on its own).
  const tools = new Map<string, ToolDescriptor | undefined>();
  for (const head of heads) {
    if (head && !tools.has(head.tool))
      tools.set(head.tool, await ctx.registry.resolve(teamId, head.tool));
  }
  const result = await withAppendTx(ctx.db, teamId, async (tx) => {
    const limits = (await readTeamRememberLimits(tx, teamId)).effective;
    if (!limits.approve_all) throw notAllowed("Your team doesn't allow approving several at once.");
    const thread = await lockThreadRow(tx, teamId, first.threadId);
    const run = await lockRunRow(tx, teamId, body.run_id);
    if (!thread || !run) throw notFound();
    if (!isActiveRunStatus(run.status)) {
      throw new ApprovalError("run_not_active", 409, "The run has ended.");
    }
    const now = ctx.now();
    const rows: ApprovalRow[] = [];
    // Locked in id order, as every path that locks several approvals of a run.
    for (const id of [...body.approval_ids].sort()) {
      const row = await loadApproval(tx, teamId, id, { lock: true });
      if (!row || row.userId !== actor.user_id || row.runId !== run.id) throw notFound();
      if (row.status !== "pending") {
        throw new ApprovalError("approval_resolved", 409, `An approval is already ${row.status}.`);
      }
      if (now >= row.expiresAt) {
        throw new ApprovalError("approval_expired", 409, "An approval request has expired.");
      }
      if (!batchable(row, tools.get(row.tool))) {
        throw notAllowed(
          `${row.tool} can delete data or reach outside Kobe, so it needs its own decision.`,
        );
      }
      if (!(await askerConnected(tx, teamId, row.userId, row.connectionId))) {
        // As for one decision (review N3): nobody waits for it, so it expires (committed).
        const expired = await expireRunApprovalsInTx(tx, teamId, run.id, "run_interrupted", row.id);
        await resumeIfNoneWaiting(tx, thread, run, row.id, expired);
        await auditExpiredApprovals(tx, teamId, expired);
        return { unavailable: true as const };
      }
      rows.push(row);
    }
    for (const row of rows) {
      await allowRowInTx(tx, keys, actor, row, now, { approveAll: true });
    }
    const last = rows[rows.length - 1];
    if (last) await resumeIfNoneWaiting(tx, thread, run, last.id, true);
    const decided: ApprovalView[] = [];
    for (const id of body.approval_ids) {
      const row = await loadApproval(tx, teamId, id);
      if (!row) throw notFound();
      decided.push(viewOf(row));
    }
    return decided;
  });
  if ("unavailable" in result) {
    throw new ApprovalError(
      "approval_unavailable",
      409,
      "The workspace that asked for one of them is no longer connected, so it expired. Nothing was approved.",
    );
  }
  return result;
}
