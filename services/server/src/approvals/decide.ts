import {
  canonicalJson,
  isActiveRunStatus,
  parseMcpToolName,
  type ActorContext,
  type ApprovalResolutionBody,
} from "@kobe/protocol";
import { signApproval } from "@kobe/protocol/node";
import { sql, withTeam } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { insertUserAllowRule } from "../policy/remember.js";
import { lockRunRow, lockThreadRow } from "../runs/store.js";
import { notifyHintInTx } from "../sandbox-wire/bus.js";
import { WIRE_DEFAULTS } from "../sandbox-wire/constants.js";
import { ApprovalError, type ApprovalContext } from "./context.js";
import { resumeIfNoneWaiting } from "./expiry.js";
import { auditExpiredApprovals, expireRunApprovalsInTx } from "./run-end.js";
import { listApprovals, loadApproval } from "./store.js";
import { viewOf, type ApprovalView } from "./view.js";

/** A connection not touched for this long has lost its replica (the wire's `staleConnectionMs`). */
const STALE_CONNECTION_SECONDS = WIRE_DEFAULTS.staleConnectionMs / 1000;

/**
 * `POST /v1/approvals/{id}` (§6.1, D29): the run's user allows or denies a pending approval.
 *
 * - **Who:** only the run's user (the thread owner whose sandbox and credentials run the call;
 *   D8 gives no role the power to consent for someone else, and install admins can't read team
 *   content). Anyone else gets 404, as for a thread they can't see.
 * - **Allow** signs `HMAC(team, run, tool_call_id, tool, token expiry, canonical input)` with the
 *   install's approval key (`@kobe/protocol` approval.ts), over the canonical input stored when the
 *   approval was requested — the exact bytes the sandbox asked about. Built-in and kobe tools have
 *   no downstream verifier (the `policy.result` is the authorisation), so their approval is marked
 *   used at once; MCP approvals stay consumable once, by the MCP proxy (KOBE-58).
 * - **Remember** (allow only) writes a user allow rule for exactly this tool (`insertUserAllowRule`,
 *   KOBE-35) in the same transaction; it lifts future risk-class and mode prompts, never an ask or
 *   deny rule.
 * - One transaction: thread → run → approval locks, decision, `approval.resolved`, run back to
 *   `running` when nothing else waits, bus hint, audit last.
 */
export async function decideApproval(
  ctx: ApprovalContext,
  actor: ActorContext,
  approvalId: string,
  body: ApprovalResolutionBody,
): Promise<ApprovalView> {
  const keys = ctx.keys;
  if (!keys) {
    throw new ApprovalError(
      "approvals_unavailable",
      503,
      "Approvals are not configured on this server.",
    );
  }
  if (body.remember !== undefined && body.decision !== "allow") {
    throw new ApprovalError("invalid_remember", 400, "Only an approval can be remembered.");
  }
  const teamId = actor.team_id;
  const notFound = () =>
    new ApprovalError("approval_not_found", 404, "No pending approval with that id.");
  const head = await withTeam(ctx.db, teamId, (tx) => loadApproval(tx, teamId, approvalId));
  if (head?.userId !== actor.user_id) throw notFound();
  const result = await withAppendTx(ctx.db, teamId, async (tx) => {
    const thread = await lockThreadRow(tx, teamId, head.threadId);
    const run = await lockRunRow(tx, teamId, head.runId);
    const row = await loadApproval(tx, teamId, approvalId, { lock: true });
    if (!thread || !run || !row || row.userId !== actor.user_id) throw notFound();
    if (row.status !== "pending") {
      throw new ApprovalError("approval_resolved", 409, `This approval is already ${row.status}.`);
    }
    const now = ctx.now();
    if (now >= row.expiresAt) {
      throw new ApprovalError("approval_expired", 409, "This approval request has expired.");
    }
    if (!isActiveRunStatus(run.status)) {
      throw new ApprovalError("run_not_active", 409, "The run has ended.");
    }
    // Only the connection that asked can deliver the answer (KOBE-37 review): with it gone, an
    // allow would sit unused while the sandbox was told "deny". Expire it instead (committed),
    // then refuse.
    if (!(await askerConnected(tx, teamId, row.userId, row.connectionId))) {
      const expired = await expireRunApprovalsInTx(tx, teamId, run.id, "run_interrupted", row.id);
      await resumeIfNoneWaiting(tx, thread, run, row.id, expired);
      await auditExpiredApprovals(tx, teamId, expired);
      return { unavailable: true as const };
    }
    let ruleId: string | undefined;
    if (body.decision === "allow") {
      const input = JSON.parse(row.inputCanonical) as unknown;
      // The stored text is canonical by construction; never sign anything else.
      if (canonicalJson(input) !== row.inputCanonical) {
        throw new Error(`approval ${row.id}: stored input is not canonical`);
      }
      const token = signApproval({
        key: keys.current,
        approval_id: row.id,
        team_id: teamId,
        run_id: row.runId,
        tool_call_id: row.toolCallId,
        tool: row.tool,
        input,
        now,
      });
      if (body.remember !== undefined) ruleId = await remember(tx, actor, row.tool, body, now);
      const usedNow = parseMcpToolName(row.tool) === undefined;
      await tx.execute(sql`
        UPDATE approvals
           SET status = 'allowed', cause = 'user', decided_by = ${actor.user_id},
               decided_at = ${now.toISOString()}, token_kid = ${token.kid},
               token_expires_at = ${token.expires_at}, input_hmac = ${token.mac},
               consumed_at = ${usedNow ? now.toISOString() : null},
               remembered = ${ruleId !== undefined}
         WHERE team_id = ${teamId} AND id = ${row.id}`);
    } else {
      await tx.execute(sql`
        UPDATE approvals
           SET status = 'denied', cause = 'user', decided_by = ${actor.user_id},
               decided_at = ${now.toISOString()}
         WHERE team_id = ${teamId} AND id = ${row.id}`);
    }
    await appendRunEventsInTx(tx, teamId, run.id, [
      {
        type: "approval.resolved",
        payload: {
          approval_id: row.id,
          tool_call_id: row.toolCallId,
          decision: body.decision === "allow" ? "allowed" : "denied",
          cause: "user",
          decided_by: actor.user_id,
          remembered: ruleId !== undefined,
        },
      },
    ]);
    await resumeIfNoneWaiting(tx, thread, run, row.id, true);
    await notifyHintInTx(tx, { kind: "apr", id: row.id });
    await recordAudit(tx, {
      action: "approval.decided",
      teamId,
      target: {
        approvalId: row.id,
        runId: row.runId,
        toolCallId: row.toolCallId,
        tool: row.tool,
        decision: body.decision,
        remember: ruleId !== undefined,
        ...(ruleId === undefined ? {} : { ruleId }),
      },
    });
    const decided = await loadApproval(tx, teamId, row.id);
    if (!decided) throw notFound();
    return viewOf(decided);
  });
  if ("unavailable" in result) {
    throw new ApprovalError(
      "approval_unavailable",
      409,
      "The workspace that asked is no longer connected, so this request expired. The tool did not run.",
    );
  }
  return result;
}

/** The asking connection is still the sandbox's open, live one (`sandbox_connections`). */
async function askerConnected(
  tx: Parameters<typeof insertUserAllowRule>[0],
  teamId: string,
  userId: string,
  connectionId: string,
): Promise<boolean> {
  const res = await tx.execute<{ ok: boolean }>(sql`
    SELECT true AS ok FROM sandbox_connections
     WHERE team_id = ${teamId} AND user_id = ${userId} AND connection_id = ${connectionId}
       AND closed_at IS NULL AND last_seen_at > now() - make_interval(secs => ${STALE_CONNECTION_SECONDS})`);
  return res.rows.length === 1;
}

async function remember(
  tx: Parameters<typeof insertUserAllowRule>[0],
  actor: ActorContext,
  tool: string,
  body: ApprovalResolutionBody,
  now: Date,
): Promise<string> {
  const result = await insertUserAllowRule(tx, {
    teamId: actor.team_id,
    userId: actor.user_id,
    approvedTool: tool,
    remember: body.remember,
    now,
    actor: { kind: "user", id: actor.user_id },
  });
  if (result.ok) return result.rule.id;
  switch (result.error) {
    case "glob_too_broad":
      throw new ApprovalError(
        "glob_too_broad",
        400,
        `A remembered approval names exactly this tool (${tool}).`,
      );
    case "too_many_rules":
      throw new ApprovalError("too_many_rules", 409, "You have too many remembered approvals.");
    default:
      throw new ApprovalError("invalid_remember", 400, "Check the remember rule.");
  }
}

export async function getApproval(
  ctx: ApprovalContext,
  actor: ActorContext,
  approvalId: string,
): Promise<ApprovalView> {
  const row = await withTeam(ctx.db, actor.team_id, (tx) =>
    loadApproval(tx, actor.team_id, approvalId),
  );
  if (row?.userId !== actor.user_id) {
    throw new ApprovalError("approval_not_found", 404, "No approval with that id.");
  }
  return viewOf(row);
}

export async function listMyApprovals(
  ctx: ApprovalContext,
  actor: ActorContext,
  filter: { readonly status?: ApprovalView["status"]; readonly runId?: string },
): Promise<ApprovalView[]> {
  const rows = await withTeam(ctx.db, actor.team_id, (tx) =>
    listApprovals(tx, actor.team_id, actor.user_id, { ...filter, limit: 100 }),
  );
  return rows.map(viewOf);
}
