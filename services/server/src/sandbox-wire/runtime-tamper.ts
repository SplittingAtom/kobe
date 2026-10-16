import { SYSTEM_ACTOR, sql, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import { withAppendTx } from "../event-stream/append.js";

/** The sandbox agent's error code for a Pi runtime another process changed (KOBE-41/71). */
export const RUNTIME_TAMPERED = "runtime_tampered";

/** Writes of the row on its own after the run's end could not commit (KOBE-271 review). */
export const TAMPER_AUDIT_ATTEMPTS = 3;
/** Pause before each of those writes (the run end's failure was often a lock timeout). */
export const TAMPER_AUDIT_RETRY_MS = 250;

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
 * (KOBE-271). Once per run: under a transaction-scoped advisory lock on the run id (held whether
 * or not the run row still exists) a run that already has its row gets no second one, so a
 * repeated or racing report adds none. Returns whether a row was written. Call it after the
 * transaction's other writes (it ends holding the audit chain lock).
 */
export async function auditRuntimeTamperInTx(
  tx: KobeTx,
  report: RuntimeTamperReport,
): Promise<boolean> {
  const { teamId, runId } = report;
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.audit.runtime_tampered:${runId}`}, 0))`);
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

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `endRun` (the transaction recording a tampered run's failure with its row). If it fails,
 * the run stays active until the lost-run sweep ends it, which knows nothing of the tamper: the
 * row is then written on its own (retried, still once per run) so the event is not lost, and the
 * original error is rethrown for the caller's handling.
 */
export async function withTamperAudit<T>(
  db: KobeDb,
  report: RuntimeTamperReport,
  log: Logger,
  endRun: () => Promise<T>,
): Promise<T> {
  try {
    return await endRun();
  } catch (err) {
    await auditRuntimeTamperAlone(db, report, log);
    throw err;
  }
}

async function auditRuntimeTamperAlone(
  db: KobeDb,
  report: RuntimeTamperReport,
  log: Logger,
): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= TAMPER_AUDIT_ATTEMPTS; attempt += 1) {
    await pause(TAMPER_AUDIT_RETRY_MS * attempt);
    try {
      await withAppendTx(db, report.teamId, (tx) => auditRuntimeTamperInTx(tx, report));
      return;
    } catch (err) {
      last = err;
    }
  }
  // Operators alert on error logs; the ids say which sandbox and run to look at.
  log.error(
    { err: last, run_id: report.runId, sandbox_id: report.sandboxId, security: true },
    "a tampered Pi runtime could not be audited",
  );
}
