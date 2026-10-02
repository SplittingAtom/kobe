import { SYSTEM_ACTOR, audit, type AuditEvent, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";

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
  | "policy_unavailable";

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
}

interface Aggregate {
  readonly record: ConnectionRecord;
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
}

const keyOf = (r: ConnectionRecord): string =>
  [r.teamId, r.userId, r.sandboxId, r.domain ?? "", r.port ?? "", r.outcome, r.reason ?? ""].join(
    "|",
  );

export class ConnectionAudit {
  private pending = new Map<string, Aggregate>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private dropped = 0;
  private readonly maxKeys: number;
  private readonly now: () => Date;

  constructor(private readonly options: ConnectionAuditOptions) {
    this.maxKeys = options.maxKeys ?? 5_000;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.options.flushMs);
    this.timer.unref();
  }

  record(record: ConnectionRecord): void {
    const key = keyOf(record);
    const at = this.now();
    const existing = this.pending.get(key);
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
      ...(r.domain === undefined ? {} : { domain: r.domain }),
      ...(r.port === undefined ? {} : { port: r.port }),
      outcome: r.outcome,
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      connections: agg.connections,
      bytesUp: agg.bytesUp,
      bytesDown: agg.bytesDown,
      from: agg.from.toISOString(),
      to: agg.to.toISOString(),
    },
  };
}
