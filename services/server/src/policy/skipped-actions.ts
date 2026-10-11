import {
  SKIPPED_ACTIONS_MAX,
  skippedActionSchema,
  type PolicyReasonCode,
  type RiskClass,
  type SkippedAction,
} from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";

/**
 * Skipped actions of scheduled runs (D32, KOBE-178): a call the policy denied instead of asking,
 * recorded in `run_skipped_actions` (KOBE-177) when it is decided. Only `trigger = 'schedule'` runs
 * are ever recorded (the insert itself checks), so interactive runs and a sandbox's claims cannot
 * add rows. Names, risk class and a reason code only: never input, output or message text.
 */

/**
 * Rows kept per run. The terminal event lists at most {@link SKIPPED_ACTIONS_MAX}; the rest of
 * these still count (`skipped_count` of the notification). A looping sandbox cannot grow the table
 * past this.
 */
export const SKIPPED_ACTIONS_STORED_MAX = 1000;

export interface SkippedActionInput {
  readonly teamId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly risk: RiskClass;
  readonly reason: PolicyReasonCode;
}

/** Records the denied call if its run is a scheduled run; idempotent per tool call. */
export async function recordSkippedActionInTx(tx: KobeTx, a: SkippedActionInput): Promise<void> {
  await tx.execute(sql`
    INSERT INTO run_skipped_actions (team_id, run_id, tool_call_id, tool, risk_class, reason)
    SELECT r.team_id, r.id, ${a.toolCallId.slice(0, 200)}, ${a.tool.slice(0, 200)},
           ${a.risk}, ${a.reason}
      FROM runs r
     WHERE r.team_id = ${a.teamId} AND r.id = ${a.runId} AND r.trigger = 'schedule'
       AND (SELECT count(*) FROM run_skipped_actions s
             WHERE s.team_id = r.team_id AND s.run_id = r.id) < ${SKIPPED_ACTIONS_STORED_MAX}
    ON CONFLICT (team_id, run_id, tool_call_id) DO NOTHING`);
}

export interface SkippedReport {
  /** The first {@link SKIPPED_ACTIONS_MAX} in decision order. */
  readonly actions: readonly SkippedAction[];
  /** All recorded for the run (at most {@link SKIPPED_ACTIONS_STORED_MAX}). */
  readonly count: number;
}

/** What a scheduled run skipped, oldest first. */
export async function loadSkippedReport(
  tx: KobeTx,
  teamId: string,
  runId: string,
): Promise<SkippedReport> {
  const res = await tx.execute<{
    tool_call_id: string;
    tool: string;
    risk_class: RiskClass;
    reason: string;
    total: number;
  }>(sql`
    SELECT tool_call_id, tool, risk_class, reason, count(*) OVER ()::int AS total
      FROM run_skipped_actions
     WHERE team_id = ${teamId} AND run_id = ${runId}
     ORDER BY created_at, tool_call_id
     LIMIT ${SKIPPED_ACTIONS_MAX}`);
  // A row the contract rejects (a reason code the protocol does not know) is left out, not fatal.
  const actions = res.rows.flatMap((r) => {
    const parsed = skippedActionSchema.safeParse({
      tool_call_id: r.tool_call_id,
      tool: r.tool,
      risk: r.risk_class,
      reason_code: r.reason,
    });
    return parsed.success ? [parsed.data] : [];
  });
  return { actions, count: res.rows[0]?.total ?? 0 };
}
