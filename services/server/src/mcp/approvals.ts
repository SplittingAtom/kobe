import { canonicalJson, type JsonObject } from "@kobe/protocol";
import { sql, withTeam, type KobeDb } from "@kobe/db";
import type { VerifyFailure } from "@kobe/protocol/node";
import type { ApprovalVerifier } from "../approvals/verify.js";

/**
 * Signed approvals at the MCP enforcement point (D29: "MCP calls are enforced a second time at the
 * MCP proxy"; Gate 2: a tampered `kobe-policy` cannot execute an MCP write without a signed
 * approval). When the policy re-check says `require_approval`, the call runs only if KOBE-37's
 * verifier (`approvals/verify.ts`) finds the signed approval for exactly this call, verifies both
 * halves of `authorizeApprovedCall` against the input about to be forwarded, and consumes it.
 *
 * Where the ids come from (none of it lets a sandbox reach another user's or run's approval):
 * - **team, user, sandbox**: the sandbox's `kobe.mcp-proxy` session token, verified by the server
 *   with that audience's key (`principal.ts`), plus liveness and membership.
 * - **run**: never taken from the sandbox. The sandbox names its thread (`Kobe-Thread-Id`); the
 *   server takes that thread's active run only if the thread is the token user's and the run is
 *   leased to the token's sandbox (`sandbox_run_leases`, written when the server delivered
 *   `run.start`). Another user's or another sandbox's thread yields no run → deny.
 * - **tool_call_id**: from `_meta["kobe.dev/tool_call_id"]` when the client sends one — a selector
 *   within that run, bound by the MAC — or else looked up here: the run's `allowed`, unconsumed
 *   approval of this user for this tool whose stored canonical input equals the call's canonical
 *   input (Pi's MCP client cannot attach a per-call id). The verifier then re-checks everything
 *   (team, user, run, tool_call_id, tool, input MAC, expiry, run active) and consumes once.
 */

export interface McpApprovalCall {
  readonly teamId: string;
  readonly userId: string;
  readonly runId: string;
  /** Pi tool name (`mcp__<server>__<tool>`), from the pinned snapshot, as signed. */
  readonly tool: string;
  /** Only when the client named one (`_meta`). */
  readonly toolCallId?: string;
  /** The exact input about to be forwarded upstream. */
  readonly input: JsonObject;
  readonly now: Date;
}

export type McpApprovalFailure = VerifyFailure | "no_approval" | "unavailable";

export type McpApprovalResult =
  | { readonly ok: true; readonly approvalId: string }
  | { readonly ok: false; readonly reason: McpApprovalFailure };

export interface McpApprovalVerifier {
  /** Verifies and consumes (single use) a signed approval for `call`. Never throws. */
  authorize(call: McpApprovalCall): Promise<McpApprovalResult>;
}

/** Nothing is authorised (a server without an approval key behaves like this too). */
export const DENY_UNVERIFIED_APPROVALS: McpApprovalVerifier = {
  authorize: () => Promise.resolve({ ok: false, reason: "unavailable" }),
};

/** The tool call id of the run's usable approval for exactly this tool and input, if any. */
async function findApprovedToolCallId(
  db: KobeDb,
  call: McpApprovalCall,
): Promise<string | undefined> {
  const input = canonicalJson(call.input);
  const res = await withTeam(db, call.teamId, (tx) =>
    tx.execute<{ tool_call_id: string }>(sql`
      SELECT tool_call_id FROM approvals
       WHERE team_id = ${call.teamId} AND run_id = ${call.runId} AND user_id = ${call.userId}
         AND tool = ${call.tool} AND status = 'allowed' AND consumed_at IS NULL
         AND input_canonical = ${input}
       ORDER BY decided_at DESC NULLS LAST, id
       LIMIT 1`),
  );
  return res.rows[0]?.tool_call_id;
}

/** The MCP proxy's verifier over KOBE-37's `ApprovalVerifier` (audits consumed/rejected itself). */
export function approvalVerifierForMcp(
  db: KobeDb,
  verifier: ApprovalVerifier,
): McpApprovalVerifier {
  return {
    async authorize(call) {
      try {
        const toolCallId = call.toolCallId ?? (await findApprovedToolCallId(db, call));
        if (toolCallId === undefined) return { ok: false, reason: "no_approval" };
        return await verifier.authorize({
          teamId: call.teamId,
          userId: call.userId,
          runId: call.runId,
          toolCallId,
          tool: call.tool,
          input: call.input,
        });
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}
