import { createHmac } from "node:crypto";
import { desc, eq, verifyAuditChain, auditLog, type KobeDb } from "@kobe/db";
import { logger } from "../logger.js";

/** Every replica logs the head this often (and once at startup). */
export const AUDIT_ANCHOR_INTERVAL_MS = 5 * 60_000;

/**
 * The chain head as the server attests it: `mac` is HMAC-SHA256 over `seq:hash` under a key derived
 * from the auth secret, which lives in a Kubernetes Secret, not in the database. The owner role can
 * rewrite rows and recompute the (unkeyed) chain, but can't produce a matching `mac` for a head it
 * invents, and can't change heads already shipped off the box.
 */
export interface AuditAnchor {
  readonly seq: number;
  readonly hash: string;
  readonly at: string;
  readonly mac: string;
}

export type AnchorStatus =
  | { readonly ok: true; readonly anchor: AuditAnchor | null }
  | {
      readonly ok: false;
      readonly anchor: AuditAnchor | null;
      readonly problem: string;
      readonly seq: number;
    };

export function anchorKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("kobe.audit.anchor.v1").digest();
}

export function anchorMac(key: Buffer, seq: number, hash: string): string {
  return createHmac("sha256", key).update(`${seq}:${hash}`).digest("hex");
}

interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Logs the audit chain head at startup and every AUDIT_ANCHOR_INTERVAL_MS (every replica), and
 * verifies the rows appended since the previous head, so the server log carries a running record
 * of the chain. Ship these lines off the box (log collector; SIEM forwarding is KOBE-19): a copy
 * outside the database is what makes a rewrite by a privileged DB role detectable.
 */
export class AuditAnchorLogger {
  private readonly key: Buffer;
  private last: AuditAnchor | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: KobeDb,
    secret: string,
    private readonly log: Log = logger,
  ) {
    this.key = anchorKey(secret);
  }

  /** The current head with its attestation (null for an empty log). */
  async head(): Promise<AuditAnchor | null> {
    const [row] = await this.db
      .select({ seq: auditLog.seq, hash: auditLog.hash })
      .from(auditLog)
      .orderBy(desc(auditLog.seq))
      .limit(1);
    return row ? this.attest(row.seq, row.hash) : null;
  }

  attest(seq: number, hash: string): AuditAnchor {
    return { seq, hash, at: new Date().toISOString(), mac: anchorMac(this.key, seq, hash) };
  }

  /** Checks the rows since the last head, then logs the new head. */
  async tick(): Promise<AnchorStatus> {
    const previous = this.last;
    if (previous) {
      const [still] = await this.db
        .select({ hash: auditLog.hash })
        .from(auditLog)
        .where(eq(auditLog.seq, previous.seq));
      if (still?.hash !== previous.hash) {
        return this.fail(previous.seq, "the previously logged head was changed or removed");
      }
      const report = await verifyAuditChain(this.db, {
        fromSeq: previous.seq + 1,
        expectedPrevHash: previous.hash,
      });
      if (!report.ok && report.problem) return this.fail(report.problem.seq, report.problem.kind);
    }
    const anchor = await this.head();
    if (anchor) {
      this.last = anchor;
      this.log.info({ auditHead: anchor }, "audit chain head");
    }
    return { ok: true, anchor };
  }

  start(): void {
    const run = () =>
      void this.tick().catch((err: unknown) =>
        this.log.error({ err }, "audit chain head could not be read"),
      );
    run();
    this.timer ??= setInterval(run, AUDIT_ANCHOR_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private fail(seq: number, problem: string): AnchorStatus {
    this.log.error(
      { auditChain: { seq, problem, lastHead: this.last } },
      "audit chain verification failed: the audit log was altered",
    );
    return { ok: false, anchor: this.last, problem, seq };
  }
}
