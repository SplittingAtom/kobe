import { SYSTEM_ACTOR, eraseExpiredAuditPii, type AuditPiiErasure, type KobeDb } from "@kobe/db";
import { logger } from "../logger.js";
import { recordAudit } from "./record.js";

/** How often each replica erases expired IPs and user agents (KOBE-17). */
export const AUDIT_PII_SWEEP_INTERVAL_MS = 10 * 60_000;
/** Rows per transaction (one `audit.pii_erased` row each). */
export const AUDIT_PII_BATCH = 1000;
/** Batches per run; the next run continues (bounds a backlog after an upgrade or restore). */
const MAX_BATCHES = 50;

export interface AuditPiiSweepResult {
  /** Rows erased in this run. */
  readonly erased: number;
  /** Rows past the period kept because of a legal hold (last batch's count). */
  readonly held: number;
}

/** One batch in one transaction: erase, then record the counts as the last write. */
async function sweepBatch(db: KobeDb, limit: number): Promise<AuditPiiErasure> {
  return db.transaction(async (tx) => {
    const result = await eraseExpiredAuditPii(tx, limit);
    if (result.rows > 0) {
      await recordAudit(tx, {
        action: "audit.pii_erased",
        actor: SYSTEM_ACTOR,
        target: { rows: result.rows, held: result.held, olderThanHours: result.olderThanHours },
      });
    }
    return result;
  });
}

/**
 * Erases the client IP and user agent of audit rows older than the install's retention period
 * (default 12 h) that no legal hold covers (KOBE-17; user decision 2026-10-03). Rows are kept;
 * the chain still verifies. Runs on every replica: rows are claimed with SKIP LOCKED, and the
 * database re-checks age and hold for every row.
 */
export async function sweepAuditPii(
  db: KobeDb,
  batch: number = AUDIT_PII_BATCH,
): Promise<AuditPiiSweepResult> {
  let erased = 0;
  let held = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const result = await sweepBatch(db, batch);
    erased += result.rows;
    held = result.held;
    if (result.rows < batch) break;
  }
  return { erased, held };
}

export class AuditPiiSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly db: KobeDb) {}

  start(): void {
    const run = () => {
      if (this.running) return;
      this.running = true;
      sweepAuditPii(this.db)
        .then(({ erased, held }) => {
          if (erased > 0 || held > 0)
            logger.info({ erased, held }, "audit IP and user agent erased");
        })
        .catch((err: unknown) => logger.error({ err }, "audit IP and user agent erasure failed"))
        .finally(() => {
          this.running = false;
        });
    };
    run();
    this.timer ??= setInterval(run, AUDIT_PII_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
