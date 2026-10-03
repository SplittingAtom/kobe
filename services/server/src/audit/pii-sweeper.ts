import {
  SYSTEM_ACTOR,
  eraseExpiredAuditPii,
  sealAuditV1,
  type AuditPiiErasure,
  type AuditSealResult,
  type KobeDb,
} from "@kobe/db";
import { logger } from "../logger.js";
import { recordAudit } from "./record.js";

/** How often each replica runs the sweep (KOBE-17); one replica at a time does the work. */
export const AUDIT_PII_SWEEP_INTERVAL_MS = 10 * 60_000;
/** Rows read per page (one transaction, one `audit.pii_erased` row when something was erased). */
export const AUDIT_PII_PAGE = 5000;
/** Pages per run; the next run continues (bounds a backlog after an upgrade or a restore). */
const MAX_PAGES = 100;
/** A broken v1 chain is re-checked this often, not every run (it reads every v1 row). */
const SEAL_RETRY_MS = 24 * 60 * 60_000;

export interface AuditPiiSweepResult {
  /** Rows erased in this run. */
  readonly erased: number;
  /** False when another replica was sweeping. */
  readonly ran: boolean;
}

/** One page in one transaction: erase, then record the count as the last write. */
async function sweepPage(db: KobeDb, pageSize: number): Promise<AuditPiiErasure | null> {
  return db.transaction(async (tx) => {
    const result = await eraseExpiredAuditPii(tx, pageSize);
    if (result && result.rows > 0) {
      await recordAudit(tx, {
        action: "audit.pii_erased",
        actor: SYSTEM_ACTOR,
        target: { rows: result.rows, olderThanHours: result.olderThanHours },
      });
    }
    return result;
  });
}

/**
 * Erases the client IP and user agent of audit rows older than the install's retention period
 * (default 12 h) that no legal hold covers (KOBE-17; user decision 2026-10-03). Rows are kept;
 * the chain still verifies. Safe on every replica: a try-lock lets one sweep at a time, and the
 * database re-checks age, hold and version for every row.
 */
export async function sweepAuditPii(
  db: KobeDb,
  pageSize: number = AUDIT_PII_PAGE,
): Promise<AuditPiiSweepResult> {
  let erased = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const result = await sweepPage(db, pageSize);
    if (!result) return { erased, ran: i > 0 };
    erased += result.rows;
    if (!result.more) break;
  }
  return { erased, ran: true };
}

export class AuditPiiSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Sealed, already sealed or nothing to seal: no need to look again in this process. */
  private sealDone = false;
  private sealTriedAt = 0;

  constructor(private readonly db: KobeDb) {}

  /**
   * Seals the rows chained before the v2 upgrade once (`audit.chain.upgraded`); their IP and user
   * agent become erasable 24 h later. A broken chain is logged at error level and never sealed.
   */
  private async seal(): Promise<void> {
    if (this.sealDone || Date.now() - this.sealTriedAt < SEAL_RETRY_MS) return;
    this.sealTriedAt = Date.now();
    const result: AuditSealResult = await sealAuditV1(this.db);
    if (result.status === "broken") {
      logger.error(
        { seq: result.seq, problem: result.kind },
        "audit chain verification failed: rows chained before the v2 upgrade are not sealed and keep their IP addresses (see docs/audit-log.md, If the chain is broken)",
      );
      return;
    }
    this.sealDone = true;
    if (result.status === "sealed") {
      logger.info(
        { throughSeq: result.throughSeq, rows: result.rows },
        "audit chain v1 rows sealed",
      );
    }
  }

  start(): void {
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.seal()
        .then(() => sweepAuditPii(this.db))
        .then(({ erased }) => {
          if (erased > 0) logger.info({ erased }, "audit IP and user agent erased");
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
