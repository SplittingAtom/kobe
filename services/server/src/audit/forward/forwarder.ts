import { listAuditEvents, type KobeDb } from "@kobe/db";
import type { ReconcileLock } from "../../sandbox/reconcile-lock.js";
import { auditHeadSeq, initialState, readState, writeState, type ForwardState } from "./state.js";
import type { AuditSink } from "./types.js";

export const AUDIT_FORWARD_LOCK = "kobe.audit-forwarding";
export const AUDIT_FORWARD_INTERVAL_MS = 15_000;
/** Rows per delivery and deliveries per run (a backlog continues on the next run). */
export const FORWARD_BATCH = 200;
const MAX_BATCHES_PER_RUN = 25;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const ERROR_MAX = 200;

/** 5 s, 10 s, 20 s ... up to 15 min after the nth consecutive failure. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

interface Log {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface AuditForwarderOptions {
  readonly db: KobeDb;
  readonly sinks: readonly AuditSink[];
  readonly lock: ReconcileLock;
  readonly log: Log;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

function describe(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
  const message = (err instanceof Error ? err.message : String(err)) + cause;
  return message.replace(/\s+/g, " ").slice(0, ERROR_MAX);
}

/**
 * Forwards new audit events to the configured SIEM destinations (KOBE-19). Runs as a sweep on
 * every replica; a session advisory lock lets one forward at a time. Each destination has a
 * durable cursor (the last delivered `seq`) in `install_settings`, advanced only after a batch was
 * accepted, so a crash or a failure repeats a batch (the event id de-duplicates) and never skips
 * one. A failure doubles the wait before the next attempt (5 s to 15 min); the state is the admin
 * health view. A destination enabled for the first time starts at the current head: the past is
 * available through the export.
 */
export class AuditForwarder {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly o: AuditForwarderOptions) {}

  /** One pass over all destinations; false when another replica holds the lock. */
  async runOnce(): Promise<boolean> {
    const result = await this.o.lock.runExclusive(async () => {
      for (const sink of this.o.sinks) {
        try {
          await this.forward(sink);
        } catch (err) {
          this.o.log.error({ err, destination: sink.name }, "audit forwarding state failed");
        }
      }
    });
    return result.ran;
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  private async forward(sink: AuditSink): Promise<void> {
    let state = await readState(this.o.db, sink.name);
    if (!state) {
      state = initialState(await auditHeadSeq(this.o.db));
      await writeState(this.o.db, sink.name, state);
    }
    if (state.nextAttemptAt && Date.parse(state.nextAttemptAt) > this.now().getTime()) return;
    const limit = this.o.batchSize ?? FORWARD_BATCH;
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const page = await listAuditEvents(this.o.db, { after: state.seq, limit });
      const last = page.events.at(-1);
      if (!last) return;
      try {
        await sink.send(page.events);
      } catch (err) {
        await this.fail(sink, state, err);
        return;
      }
      state = {
        ...state,
        seq: last.seq,
        delivered: state.delivered + page.events.length,
        failures: 0,
        nextAttemptAt: null,
        lastSuccessAt: this.now().toISOString(),
      };
      await writeState(this.o.db, sink.name, state);
      if (page.nextCursor === null) return;
    }
  }

  private async fail(sink: AuditSink, state: ForwardState, err: unknown): Promise<void> {
    const failures = state.failures + 1;
    const now = this.now();
    const next: ForwardState = {
      ...state,
      failures,
      nextAttemptAt: new Date(now.getTime() + backoffMs(failures)).toISOString(),
      lastErrorAt: now.toISOString(),
      lastError: describe(err),
    };
    this.o.log.warn(
      { destination: sink.name, failures, error: next.lastError, retryAt: next.nextAttemptAt },
      "audit forwarding failed; will retry",
    );
    await writeState(this.o.db, sink.name, next);
  }

  start(): void {
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((err: unknown) => this.o.log.error({ err }, "audit forwarding run failed"))
        .finally(() => {
          this.running = false;
        });
    };
    run();
    this.timer ??= setInterval(run, AUDIT_FORWARD_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
