import { SYSTEM_ACTOR, audit, type AuditEvent, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { RateBuckets } from "./rate-buckets.js";

/**
 * Connection log (spec D28 "every connection is logged (domain, team, user, bytes) to the audit
 * view", D31). The audit chain serializes appends, so connections are aggregated: one
 * `egress.connection` row per (team, user, sandbox, host, port, outcome, reason) and flush window,
 * counting every connection exactly once. Each connection is also logged individually by the
 * proxy (stdout, for SIEM forwarding).
 */
export type ConnectionOutcome = "allowed" | "blocked" | "failed";
export type ConnectionReason =
  | "not_enabled"
  | "not_in_ceiling"
  | "forbidden_address"
  | "sni_mismatch"
  | "invalid_target"
  | "port_not_allowed"
  | "plain_http"
  | "connection_limit"
  | "dns_failure"
  | "upstream_unreachable"
  | "policy_unavailable"
  | "inactive_member"
  // KOBE-39 header injection (plain HTTP the proxy upgrades to verified HTTPS).
  | "headers_required"
  | "upstream_tls"
  | "upstream_timeout"
  | "request_too_large"
  | "response_too_large";

export interface ConnectionRecord {
  readonly teamId: string;
  readonly userId: string;
  readonly sandboxId: string;
  readonly domain: string | undefined;
  readonly port: number | undefined;
  readonly outcome: ConnectionOutcome;
  readonly reason: ConnectionReason | undefined;
  readonly bytesUp: number;
  readonly bytesDown: number;
  /** A plain-HTTP request the proxy upgraded to HTTPS with injected headers (KOBE-39). */
  readonly upgraded?: boolean;
}

interface Aggregate {
  readonly record: ConnectionRecord;
  readonly aggregated: boolean;
  connections: number;
  bytesUp: number;
  bytesDown: number;
  from: Date;
  to: Date;
}

export type AuditWriter = (events: readonly AuditEvent[]) => Promise<void>;

/** Rows per transaction: each append holds the audit chain lock until commit. */
const ROWS_PER_TX = 100;

export function dbAuditWriter(db: KobeDb): AuditWriter {
  return async (events) => {
    for (let i = 0; i < events.length; i += ROWS_PER_TX) {
      const batch = events.slice(i, i + ROWS_PER_TX);
      await db.transaction(async (tx) => {
        for (const event of batch) await audit(tx, event);
      });
    }
  };
}

export interface ConnectionAuditOptions {
  readonly write: AuditWriter;
  readonly logger: Logger;
  readonly flushMs: number;
  /** Distinct keys kept between flushes; reaching it flushes early. */
  readonly maxKeys?: number;
  readonly now?: () => Date;
  /**
   * New distinct (host, port, outcome, reason) keys per sandbox: burst, then per second. Beyond
   * it a sandbox's connections collapse into one `aggregated` row per outcome (random-host floods).
   */
  readonly distinctKeys?: { readonly burst: number; readonly perSecond: number };
}

const keyOf = (r: ConnectionRecord, aggregated: boolean): string =>
  aggregated
    ? [r.teamId, r.userId, r.sandboxId, "*", "*", r.outcome, "*"].join("|")
    : [
        r.teamId,
        r.userId,
        r.sandboxId,
        r.domain ?? "",
        r.port ?? "",
        r.outcome,
        r.reason ?? "",
        r.upgraded ? "upgraded" : "",
      ].join("|");

export class ConnectionAudit {
  private pending = new Map<string, Aggregate>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private dropped = 0;
  private readonly maxKeys: number;
  private readonly now: () => Date;
  private readonly newKeys: RateBuckets;

  constructor(private readonly options: ConnectionAuditOptions) {
    this.maxKeys = options.maxKeys ?? 5_000;
    this.now = options.now ?? (() => new Date());
    const rate = options.distinctKeys ?? { burst: 32, perSecond: 0.5 };
    this.newKeys = new RateBuckets({ ...rate, now: () => this.now().getTime() });
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.options.flushMs);
    this.timer.unref();
  }

  record(record: ConnectionRecord): void {
    const at = this.now();
    let aggregated = false;
    let key = keyOf(record, false);
    let existing = this.pending.get(key);
    if (!existing && !this.newKeys.take(`${record.teamId}|${record.sandboxId}`)) {
      aggregated = true;
      key = keyOf(record, true);
      existing = this.pending.get(key);
    }
    if (existing) {
      existing.connections += 1;
      existing.bytesUp += record.bytesUp;
      existing.bytesDown += record.bytesDown;
      existing.to = at;
      return;
    }
    if (this.pending.size >= this.maxKeys * 2) {
      // The database has been unreachable for a while: keep memory bounded, say what was lost.
      this.dropped += 1;
      return;
    }
    this.pending.set(key, {
      record,
      aggregated,
      connections: 1,
      bytesUp: record.bytesUp,
      bytesDown: record.bytesDown,
      from: at,
      to: at,
    });
    if (this.pending.size >= this.maxKeys) void this.flush();
  }

  /** Writes everything pending; on failure the rows are kept for the next attempt. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.pending.size === 0) return Promise.resolve();
    const batch = this.pending;
    this.pending = new Map();
    const events = [...batch.values()].map(toEvent);
    this.flushing = this.options
      .write(events)
      .catch((err: unknown) => {
        this.options.logger.error(
          { err, rows: events.length },
          "egress connection audit could not be written; will retry",
        );
        for (const [key, agg] of batch) {
          const newer = this.pending.get(key);
          if (newer) {
            newer.connections += agg.connections;
            newer.bytesUp += agg.bytesUp;
            newer.bytesDown += agg.bytesDown;
            newer.from = agg.from;
          } else if (this.pending.size < this.maxKeys * 2) {
            this.pending.set(key, agg);
          } else {
            this.dropped += agg.connections;
          }
        }
      })
      .finally(() => {
        this.flushing = undefined;
        if (this.dropped > 0) {
          this.options.logger.error(
            { connections: this.dropped },
            "egress connection audit rows dropped (audit log unreachable)",
          );
          this.dropped = 0;
        }
      });
    return this.flushing;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flushing;
    await this.flush();
  }
}

function toEvent(agg: Aggregate): AuditEvent {
  const r = agg.record;
  return {
    action: "egress.connection",
    actor: SYSTEM_ACTOR,
    teamId: r.teamId,
    target: {
      userId: r.userId,
      sandboxId: r.sandboxId,
      ...(agg.aggregated || r.domain === undefined ? {} : { domain: r.domain }),
      ...(agg.aggregated || r.port === undefined ? {} : { port: r.port }),
      outcome: r.outcome,
      ...(agg.aggregated || r.reason === undefined ? {} : { reason: r.reason }),
      ...(agg.aggregated ? { aggregated: true as const } : {}),
      ...(!agg.aggregated && r.upgraded ? { upgraded: true as const } : {}),
      connections: agg.connections,
      bytesUp: agg.bytesUp,
      bytesDown: agg.bytesDown,
      from: agg.from.toISOString(),
      to: agg.to.toISOString(),
    },
  };
}
