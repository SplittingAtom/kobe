import {
  EGRESS_BLOCKED_CHANNEL,
  EGRESS_BLOCKED_EVENT_KIND,
  events,
  sql,
  withTeam,
  type KobeDb,
} from "@kobe/db";
import type { Logger } from "pino";
import { RateBuckets } from "./rate-buckets.js";

/**
 * The `egress.blocked` seam (spec D28, §6.2): when the proxy refuses a sandbox a host, the run that
 * tried it should show "blocked" with a Request access action (KOBE-39). The proxy sees
 * connections, not runs, so it records a pending `events` row in the sandbox's team
 * (kind `egress.blocked`, ref = what was attempted) and NOTIFYs `<team_id>:<event_id>` (ids only);
 * the server's relay turns it into an `egress.blocked` run event on the user's active run(s).
 *
 * Retries hammer: one report per (sandbox, host) per `windowMs`, and a bounded number in flight.
 */
export interface BlockedAttempt {
  readonly teamId: string;
  readonly userId: string;
  readonly sandboxId: string;
  readonly domain: string;
  readonly port: number;
  readonly reason: string;
  /** In the ceiling but not enabled: the team admin can enable it (Request access). */
  readonly requestAccess: boolean;
  readonly threadHint: string | undefined;
}

export type BlockedSink = (attempt: BlockedAttempt) => Promise<void>;

export function dbBlockedSink(db: KobeDb): BlockedSink {
  return async (a) => {
    await withTeam(db, a.teamId, async (tx) => {
      const [row] = await tx
        .insert(events)
        .values({
          teamId: a.teamId,
          kind: EGRESS_BLOCKED_EVENT_KIND,
          status: "pending",
          ref: {
            sandbox_id: a.sandboxId,
            user_id: a.userId,
            domain: a.domain,
            port: a.port,
            reason: a.reason,
            request_access: a.requestAccess,
            ...(a.threadHint === undefined ? {} : { thread_id: a.threadHint }),
          },
        })
        .returning({ id: events.id });
      if (!row) throw new Error("events insert returned no row");
      await tx.execute(
        sql`SELECT pg_notify(${EGRESS_BLOCKED_CHANNEL}, ${`${a.teamId}:${row.id}`})`,
      );
    });
  };
}

export interface BlockedReporterOptions {
  readonly sink: BlockedSink;
  readonly logger: Logger;
  readonly windowMs?: number;
  readonly maxInFlight?: number;
  readonly maxKeys?: number;
  readonly now?: () => number;
  /** Reports per sandbox across all hosts: burst, then per second (random-host floods). */
  readonly perSandbox?: { readonly burst: number; readonly perSecond: number };
}

export class BlockedReporter {
  private readonly recent = new Map<string, number>();
  private inFlight = 0;
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly perSandbox: RateBuckets;
  private suppressed = 0;

  constructor(private readonly options: BlockedReporterOptions) {
    this.now = options.now ?? (() => Date.now());
    this.perSandbox = new RateBuckets({
      ...(options.perSandbox ?? { burst: 5, perSecond: 0.1 }),
      now: this.now,
    });
  }

  report(attempt: BlockedAttempt): void {
    const windowMs = this.options.windowMs ?? 30_000;
    const key = `${attempt.sandboxId}|${attempt.domain}|${attempt.reason}`;
    const now = this.now();
    const last = this.recent.get(key);
    if (last !== undefined && now - last < windowMs) return;
    if (this.inFlight >= (this.options.maxInFlight ?? 50)) return;
    if (!this.perSandbox.take(`${attempt.teamId}|${attempt.sandboxId}`)) {
      // Still counted in the egress.connection audit; only the run event is skipped.
      if (this.suppressed++ % 1_000 === 0) {
        this.options.logger.info(
          { sandbox: attempt.sandboxId },
          "egress.blocked reports rate-limited",
        );
      }
      return;
    }
    this.recent.delete(key);
    this.recent.set(key, now);
    if (this.recent.size > (this.options.maxKeys ?? 10_000)) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
    this.inFlight += 1;
    const write = this.options
      .sink(attempt)
      .catch((err: unknown) => {
        this.options.logger.warn(
          { err, team: attempt.teamId },
          "egress.blocked event not recorded",
        );
      })
      .finally(() => {
        this.inFlight -= 1;
        this.pendingWrites.delete(write);
      });
    this.pendingWrites.add(write);
  }

  /** Waits for writes in flight (shutdown, tests). */
  async drain(): Promise<void> {
    await Promise.all([...this.pendingWrites]);
  }
}
