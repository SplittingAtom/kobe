import type { ModelUsageRecord } from "@kobe/db";
import type { Logger } from "pino";
import type { CallRecord, UsageSink } from "../seams.js";

/**
 * The `run_usage` writer (KOBE-43): every forwarded model call that named a model becomes one
 * ledger row. Calls end on the request path, so rows are queued and written in batches (one
 * transaction per team) every `flushMs`; a failed write is retried on the next flush, up to
 * `maxAttempts` times, and nothing is dropped silently. The queue is bounded (`maxQueue`): past it
 * the oldest rows are dropped with an error log, so a database outage cannot exhaust the shim's
 * memory.
 */
export interface DbUsageSinkOptions {
  readonly write: (records: readonly ModelUsageRecord[]) => Promise<number>;
  readonly logger: Logger;
  readonly flushMs?: number;
  readonly maxBatch?: number;
  readonly maxQueue?: number;
  readonly maxAttempts?: number;
  /** After a team's rows are written (KOBE-42: drop budget caches, wake the budget monitor). */
  readonly onWritten?: (teamId: string) => void;
  /** Delay from a recorded call to its write (calls close together share one batch). */
  readonly soonMs?: number;
}

interface Queued {
  readonly record: ModelUsageRecord;
  readonly attempts: number;
  /** Written on its own after its batch failed, so one bad row cannot sink the others. */
  readonly alone?: boolean;
}

/** The ledger row for a call, or undefined when it is not a model call that reached Bifrost. */
export function usageRecordOf(call: CallRecord): ModelUsageRecord | undefined {
  if (!call.usage || !call.model) return undefined;
  const { counts, source } = call.usage;
  return {
    teamId: call.teamId,
    userId: call.userId,
    sandboxId: call.sandboxId,
    runId: call.runId,
    at: call.startedAt,
    route: call.route,
    model: call.model,
    status: call.status,
    inputTokens: counts.input,
    outputTokens: counts.output,
    cacheReadTokens: counts.cacheRead,
    cacheWriteTokens: counts.cacheWrite,
    usageSource: source,
    durationMs: call.durationMs,
    ttfbMs: call.ttfbMs,
    aborted: call.aborted,
  };
}

export class DbUsageSink implements UsageSink {
  private queue: Queued[] = [];
  private readonly timer: NodeJS.Timeout;
  private flushing: Promise<void> | undefined;
  private soon: NodeJS.Timeout | undefined;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly maxAttempts: number;

  constructor(private readonly options: DbUsageSinkOptions) {
    this.maxBatch = options.maxBatch ?? 500;
    this.maxQueue = options.maxQueue ?? 50_000;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.timer = setInterval(() => void this.flush(), options.flushMs ?? 1_000);
    this.timer.unref();
  }

  record(call: CallRecord): void {
    // Metadata only, never content (KOBE-40's log line, now with the token counts).
    this.options.logger.info({ call }, "model call");
    const record = usageRecordOf(call);
    if (record) {
      this.enqueue([{ record, attempts: 0 }]);
      // Budgets judge what the ledger holds: write promptly, not only on the interval.
      this.soon ??= setTimeout(() => {
        this.soon = undefined;
        void this.flush();
      }, this.options.soonMs ?? 0);
      this.soon.unref();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  private enqueue(items: readonly Queued[], front = false): void {
    this.queue = front ? [...items, ...this.queue] : [...this.queue, ...items];
    const excess = this.queue.length - this.maxQueue;
    if (excess > 0) {
      this.queue = this.queue.slice(excess);
      this.options.logger.error(
        { dropped: excess },
        "usage queue full: dropped the oldest model usage records",
      );
    }
  }

  /** Writes what is queued (one batch per call; concurrent calls share one flush). */
  flush(): Promise<void> {
    this.flushing ??= this.flushOnce().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, this.maxBatch);
      this.queue = this.queue.slice(batch.length);
      // One write (one transaction) per team: a failure retries only that team's rows, so a
      // retry never writes another team's rows twice. Rows of a failed batch retry one by one.
      const groups = new Map<string, Queued[]>();
      for (const [i, q] of batch.entries()) {
        const key = q.alone ? `alone:${i}` : q.record.teamId;
        groups.set(key, [...(groups.get(key) ?? []), q]);
      }
      const failed: Queued[] = [];
      for (const items of groups.values()) {
        try {
          await this.options.write(items.map((q) => q.record));
          const teamId = items[0]?.record.teamId;
          if (teamId) this.options.onWritten?.(teamId);
        } catch (err) {
          failed.push(...items);
          this.options.logger.error(
            { err, teamId: items[0]?.record.teamId, records: items.length },
            "writing model usage failed",
          );
        }
      }
      if (failed.length > 0) {
        const retry = failed
          .map((q) => ({ record: q.record, attempts: q.attempts + 1, alone: true }))
          .filter((q) => q.attempts < this.maxAttempts);
        if (retry.length < failed.length) {
          this.options.logger.error(
            { dropped: failed.length - retry.length },
            "model usage records dropped after repeated write failures",
          );
        }
        this.enqueue(retry, true);
        return;
      }
    }
  }

  /** Stops the timer and writes what is left (shutdown). */
  async close(): Promise<void> {
    clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    await this.flush();
  }
}
