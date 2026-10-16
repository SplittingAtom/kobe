import { SYSTEM_ACTOR, sql, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/** The sandbox agent's error code for a Pi runtime another process changed (KOBE-41/71). */
export const RUNTIME_TAMPERED = "runtime_tampered";

const ACTION = "sandbox.runtime_tampered";

/** Who reported a tampered runtime for which run: ids only (KOBE-271). */
export interface RuntimeTamperReport {
  readonly teamId: string;
  /** The sandbox's owner. */
  readonly userId: string;
  readonly sandboxId: string;
  /** The replica holding the sandbox's connection. */
  readonly replicaId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly runKind: "message" | "compaction";
}

/**
 * Records `sandbox.runtime_tampered` in `tx`, the transaction that records the run's failure
 * (KOBE-271). Once per run: under the run row's lock (`endRunInTx` holds it already) a report
 * whose run has its row is not written again, so a repeated or racing report adds none. Returns
 * whether a row was written. Call it after the transaction's other writes (the audit chain lock).
 */
export async function auditRuntimeTamperInTx(
  tx: KobeTx,
  report: RuntimeTamperReport,
): Promise<boolean> {
  const { teamId, runId } = report;
  await tx.execute(sql`
    SELECT 1 FROM runs WHERE team_id = ${teamId} AND id = ${runId} FOR NO KEY UPDATE`);
  const seen = await tx.execute(sql`
    SELECT 1 FROM audit_log
     WHERE team_id = ${teamId} AND action = ${ACTION} AND target->>'runId' = ${runId}
     LIMIT 1`);
  if (seen.rows.length > 0) return false;
  await recordAudit(tx, {
    action: ACTION,
    actor: SYSTEM_ACTOR,
    teamId,
    target: {
      sandboxId: report.sandboxId,
      userId: report.userId,
      threadId: report.threadId,
      runId,
      runKind: report.runKind,
      replicaId: report.replicaId,
    },
  });
  return true;
}
