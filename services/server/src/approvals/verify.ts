import type { PolicyDecision, PolicyEngine, PolicyInput, PolicyReason } from "@kobe/protocol";
import { authorizeApprovedCall, type VerifyFailure } from "@kobe/protocol/node";
import { SYSTEM_ACTOR, withTeam, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import type { ApprovalKeyring } from "./keys.js";
import { consumeApprovalInTx, loadApprovalForCall, loadApprovalRecord, tokenOf } from "./store.js";

/**
 * The verify-signature seam for the MCP proxy (KOBE-58; Gate 2: "a sandbox with a tampered
 * kobe-policy extension still cannot execute an MCP write without a signed approval").
 *
 * The proxy never trusts the sandbox for an approval: it finds the approval itself by
 * (team, run, tool_call_id) — the token never leaves the server side — and runs both halves of
 * `@kobe/protocol` approval.ts against **the input it is about to forward**:
 * 1. stateless: token binding (team, run, tool_call_id, tool) equals the call, key known, token
 *    unexpired, HMAC over `canonicalJson(input)` matches (constant time);
 * 2. stateful: the row is `allowed`, its MAC equals the token's, the run is active, and the
 *    approval is consumed exactly once (one conditional UPDATE), audited `approval.consumed`.
 *
 * Any failure is a refusal, audited `approval.rejected` (throttled per run and reason). A tampered
 * kobe-policy can skip the server's check, change the input after approval, reuse a tool call id,
 * borrow another run's approval or wait out the token — each lands here as a refusal.
 */

export interface ApprovedCall {
  readonly teamId: string;
  /** The sandbox's user (the MCP proxy's verified session token `user_id`). */
  readonly userId: string;
  readonly runId: string;
  readonly toolCallId: string;
  /** Tool name as Pi sees it, from the proxy's own registry. */
  readonly tool: string;
  /** The parsed `params.arguments` the proxy is about to forward (`toolInputSchema`-valid). */
  readonly input: unknown;
}

export type ApprovalCheck =
  | { readonly ok: true; readonly approvalId: string }
  | { readonly ok: false; readonly reason: VerifyFailure | "no_approval" };

export interface ApprovalVerifier {
  /** Verifies and consumes the signed approval of `call`. Never throws: errors refuse. */
  authorize(call: ApprovedCall): Promise<ApprovalCheck>;
}

const REJECT_AUDIT_EVERY_MS = 5 * 60_000;

export function createApprovalVerifier(options: {
  readonly db: KobeDb;
  readonly keys: ApprovalKeyring | undefined;
  readonly now?: () => Date;
  readonly log?: Logger;
}): ApprovalVerifier {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const audited = new Map<string, number>();

  const reject = async (
    call: ApprovedCall,
    reason: VerifyFailure | "no_approval",
    approvalId?: string,
  ): Promise<ApprovalCheck> => {
    const key = `${call.teamId}:${call.runId}:${reason}`;
    if (Date.now() - (audited.get(key) ?? 0) >= REJECT_AUDIT_EVERY_MS) {
      if (audited.size > 10_000) audited.clear();
      audited.set(key, Date.now());
      try {
        await withTeam(db, call.teamId, (tx) =>
          recordAudit(tx, {
            action: "approval.rejected",
            actor: SYSTEM_ACTOR,
            teamId: call.teamId,
            target: {
              runId: call.runId,
              toolCallId: call.toolCallId,
              tool: call.tool,
              reason,
              enforcementPoint: "mcp_proxy",
              ...(approvalId === undefined ? {} : { approvalId }),
            },
          }),
        );
      } catch (err) {
        options.log?.error({ err, run_id: call.runId }, "could not audit a rejected approval");
      }
    }
    return { ok: false, reason };
  };

  return {
    async authorize(call) {
      try {
        if (!options.keys) return await reject(call, "unknown_key");
        const keys = options.keys;
        const row = await withTeam(db, call.teamId, (tx) =>
          loadApprovalForCall(tx, call.teamId, call.runId, call.toolCallId),
        );
        if (!row) return await reject(call, "no_approval");
        if (row.userId !== call.userId) return await reject(call, "record_mismatch", row.id);
        const token = tokenOf(row);
        if (!token) return await reject(call, "not_allowed", row.id);
        const result = await authorizeApprovedCall({
          token,
          expected: {
            team_id: call.teamId,
            run_id: call.runId,
            tool_call_id: call.toolCallId,
            tool: call.tool,
          },
          input: call.input,
          now: now(),
          keyFor: (kid) => keys.keyFor(kid),
          store: {
            load: (teamId, approvalId) =>
              withTeam(db, teamId, (tx) => loadApprovalRecord(tx, teamId, approvalId)),
            // Consumption and its audit row commit together.
            consume: (teamId, approvalId) =>
              withTeam(db, teamId, async (tx) => {
                if (!(await consumeApprovalInTx(tx, teamId, approvalId))) return false;
                await recordAudit(tx, {
                  action: "approval.consumed",
                  actor: SYSTEM_ACTOR,
                  teamId,
                  target: {
                    approvalId,
                    runId: call.runId,
                    toolCallId: call.toolCallId,
                    tool: call.tool,
                    enforcementPoint: "mcp_proxy",
                  },
                });
                return true;
              }),
          },
        });
        return result.ok
          ? { ok: true, approvalId: result.token.approval_id }
          : await reject(call, result.reason, row.id);
      } catch (err) {
        options.log?.error({ err, run_id: call.runId }, "approval verification failed (refused)");
        return { ok: false, reason: "malformed" };
      }
    },
  };
}

export type McpEnforcement =
  | { readonly decision: "allow"; readonly reasons: readonly PolicyReason[] }
  | {
      readonly decision: "deny";
      readonly reasons: readonly PolicyReason[];
      readonly message: string;
    };

/**
 * The MCP proxy's second enforcement (D27, D29), composed: the policy engine decides again at
 * `enforcement_point: "mcp_proxy"`; `allow` and `deny` stand; `require_approval` runs only with a
 * valid signed approval for exactly this call (verified and consumed above), else it is denied.
 * KOBE-58 builds `input` from its own state (verified session token, registry, parsed arguments).
 */
export async function enforceMcpCall(
  engine: PolicyEngine,
  verifier: ApprovalVerifier,
  input: PolicyInput,
): Promise<McpEnforcement> {
  let decision: PolicyDecision;
  try {
    decision = await engine.decide(input);
  } catch {
    decision = {
      effect: "deny",
      risk: input.tool.risk,
      reasons: [{ code: "policy_error", stage: "install_deny", message: "Policy failed." }],
    };
  }
  if (decision.effect === "allow") return { decision: "allow", reasons: decision.reasons };
  if (decision.effect === "deny") {
    return {
      decision: "deny",
      reasons: decision.reasons,
      message: decision.reasons[0]?.message ?? "Denied by policy.",
    };
  }
  const check = await verifier.authorize({
    teamId: input.team_id,
    userId: input.actor.user_id,
    runId: input.run.run_id,
    toolCallId: input.tool_call_id,
    tool: input.tool.name,
    input: input.input,
  });
  if (check.ok) {
    return {
      decision: "allow",
      reasons: [{ code: "approval_granted", stage: "prompt", message: "Approved by the user." }],
    };
  }
  return {
    decision: "deny",
    reasons: decision.reasons,
    message: `This call needs a signed approval for exactly this input (${check.reason}).`,
  };
}
