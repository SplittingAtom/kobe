import { rememberScopeSchema, type PolicyDecision, type PolicyReason } from "@kobe/protocol";
import { sql, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { liveUserRule } from "./live-rule.js";

/** The member's remembered approval that allowed this decision, if one did. */
export function appliedUserRule(decision: PolicyDecision): PolicyReason | undefined {
  if (decision.effect !== "allow") return undefined;
  return decision.reasons.find((r) => r.code === "user_allow_rule" && r.rule_id !== undefined);
}

export interface RuleApplication {
  readonly teamId: string;
  /** The member whose rule it is and whose call runs (the audit row's actor). */
  readonly userId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly ruleId: string;
  readonly enforcementPoint: "sandbox" | "mcp_proxy";
  /** The run's event cap: the tool card's event is skipped near it (the audit row never is). */
  readonly runMaxEvents: number;
  /** Whether to append `policy.rule_applied` (the sandbox's check; the proxy's repeats it). */
  readonly announce: boolean;
}

/**
 * Records that a remembered approval let a call run without asking (KOBE-289 ac-6), before the
 * call runs: the rule's `last_used_at`, an audit row naming the rule (`policy.rule.applied`), and
 * for the tool card `policy.rule_applied` ("Allowed by your rule (<scope>)"). One transaction.
 *
 * Returns false when the rule is gone or no longer live (revoked, its thread archived or its run
 * ended since it was read; review N1): the caller denies the
 * call, so a revocation takes effect even for a decision already in flight. Throws on a failed
 * write: the caller denies then too (no audit row, no call).
 */
export async function recordRuleApplied(db: KobeDb, a: RuleApplication): Promise<boolean> {
  return withAppendTx(db, a.teamId, async (tx) => {
    const res = await tx.execute<{ remember_scope: string }>(sql`
      UPDATE tool_rules SET last_used_at = now()
       WHERE team_id = ${a.teamId} AND id = ${a.ruleId}::uuid AND scope = 'user'
         AND user_id = ${a.userId}::uuid AND ${liveUserRule(new Date())}
       RETURNING remember_scope`);
    const scope = rememberScopeSchema.safeParse(res.rows[0]?.remember_scope);
    if (!scope.success) return false;
    await recordAudit(tx, {
      action: "policy.rule.applied",
      teamId: a.teamId,
      actor: { kind: "user", id: a.userId },
      target: {
        ruleId: a.ruleId,
        runId: a.runId,
        toolCallId: a.toolCallId,
        tool: a.tool,
        rememberScope: scope.data,
        enforcementPoint: a.enforcementPoint,
      },
    });
    if (!a.announce) return true;
    const run = await tx.execute<{ last_seq: number }>(sql`
      SELECT last_seq FROM runs WHERE team_id = ${a.teamId} AND id = ${a.runId}`);
    // Keep room for the call's own events and the terminal event (as the ingest does).
    if ((run.rows[0]?.last_seq ?? a.runMaxEvents) + 4 > a.runMaxEvents) return true;
    await appendRunEventsInTx(tx, a.teamId, a.runId, [
      {
        type: "policy.rule_applied",
        payload: {
          tool_call_id: a.toolCallId,
          tool: a.tool,
          rule_id: a.ruleId,
          scope: scope.data,
        },
      },
    ]);
    return true;
  });
}
