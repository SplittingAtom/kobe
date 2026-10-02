import type { PiEventFrame, PiGetEntriesData } from "@kobe/protocol";
import { sql, type KobeDb } from "@kobe/db";
import {
  appendRunEventsInTx,
  MAX_APPEND_BATCH,
  withAppendTx,
  type NewRunEvent,
} from "../event-stream/append.js";
import type { WireTuning } from "./constants.js";
import { entryCommittedEvents, mirrorEntriesInTx } from "./entries.js";
import { endRunInTx } from "./run-state.js";
import type { RunTranslator } from "./translate.js";

/** What the ingest needs from its connection. */
export interface IngestHost {
  sendAck(runId: string, seq: number): void;
  sendResend(runId: string, fromSeq: number): void;
  sendError(code: "malformed_frame" | "run_not_active", message: string, ref?: string): void;
  /** New session entries of the thread (`get_entries since`), or undefined when unavailable. */
  fetchNewEntries(threadId: string): Promise<PiGetEntriesData | undefined>;
  /** The run ended (committed). `status` is what this ingest wrote, undefined if someone else ended it. */
  runEnded(runId: string, status: "completed" | undefined): void;
  /** A storage cap was hit: fail and stop the run (it has not been ended yet). */
  limitExceeded(runId: string, limit: "run_events" | "run_bytes" | "thread_entries"): void;
  /** Entries could not be mirrored at run end: sync the thread before its next run. */
  needsSync(threadId: string): void;
  /** Writes keep failing: drop the connection (the agent resumes from the durable cursor). */
  failed(err: unknown): void;
  log: { warn(obj: object, msg: string): void; debug(obj: object, msg: string): void };
  readonly metrics: {
    framesAccepted: number;
    framesDuplicate: number;
    gaps: number;
    writes: number;
  };
}

export interface RunIngestOptions {
  readonly db: KobeDb;
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  /** Durable cursor (`runs.sandbox_seq`) when the lease was taken. */
  readonly cursor: number;
  /** Fresh translator state (recreated after a failed batch: resent frames are translated again). */
  readonly createTranslator: () => RunTranslator;
  readonly host: IngestHost;
  readonly tuning: WireTuning;
}

const SETTLE_SYNC_ATTEMPTS = 3;

export class LimitExceeded extends Error {
  constructor(readonly limit: "run_events" | "run_bytes" | "thread_entries") {
    super(`sandbox storage limit: ${limit}`);
  }
}

class CursorConflict extends Error {
  constructor(
    readonly cursor: number,
    readonly active: boolean,
  ) {
    super("sandbox cursor conflict");
  }
}

interface Queued {
  readonly frame: PiEventFrame;
  readonly bytes: number;
}

const DELTAS = new Set(["text.delta", "reasoning.delta"]);

/** Concatenates adjacent deltas of the same message part (order otherwise unchanged). */
export function coalesceDeltas(events: readonly NewRunEvent[], maxChars = 16_384): NewRunEvent[] {
  const out: NewRunEvent[] = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (prev && DELTAS.has(event.type) && prev.type === event.type) {
      const a = prev.payload as { message_id: string; content_index: number; delta: string };
      const b = event.payload as { message_id: string; content_index: number; delta: string };
      if (
        a.message_id === b.message_id &&
        a.content_index === b.content_index &&
        a.delta.length + b.delta.length <= maxChars
      ) {
        out[out.length - 1] = { type: prev.type, payload: { ...a, delta: a.delta + b.delta } };
        continue;
      }
    }
    out.push(event);
  }
  return out;
}

/**
 * Accepts one run's `pi.event` frames in seq order (sandbox-wire/connection.ts "Delivery and
 * resume"). Frames are translated, coalesced for up to `batchWindowMs`, and committed in ONE
 * transaction per batch that advances the durable cursor by compare-and-set
 * (`sandbox_seq = last WHERE sandbox_seq = first - 1`, a batch generalisation of the per-frame
 * statement) together with the appended `run_events` and mirrored `thread_entries`; the cumulative
 * `ack` goes out only after commit. Duplicates (seq ≤ cursor) are dropped and acked; a gap is
 * dropped and answered with `resend` from the next expected seq. Memory is bounded: past
 * `runQueueMaxBytes` frames are dropped and fetched again with `resend` once the queue drains, so a
 * fast sandbox never makes the server buffer without limit and the socket is never paused (command
 * results must still get through while a batch waits for `get_entries`).
 */
export class RunIngest {
  readonly #o: RunIngestOptions;
  readonly #maxBytes: number;
  #cursor: number;
  #next: number;
  #queue: Queued[] = [];
  #queuedBytes = 0;
  #starvedFrom: number | undefined;
  #lastResend: { from: number; at: number } | undefined;
  #working = false;
  #wake: (() => void) | undefined;
  #closed = false;
  #ended = false;
  #failures = 0;
  #translator: RunTranslator;

  constructor(options: RunIngestOptions) {
    this.#o = options;
    this.#translator = options.createTranslator();
    this.#maxBytes = options.tuning.runQueueMaxBytes;
    this.#cursor = options.cursor;
    this.#next = options.cursor + 1;
  }

  get cursor(): number {
    return this.#cursor;
  }

  get queued(): number {
    return this.#queue.length;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Synchronous: called in frame arrival order. */
  push(frame: PiEventFrame, bytes: number): void {
    const host = this.#o.host;
    if (this.#closed) return;
    if (frame.seq < this.#next) {
      host.metrics.framesDuplicate += 1;
      if (frame.seq <= this.#cursor) host.sendAck(this.#o.runId, this.#cursor);
      return; // queued or in flight: acked when committed
    }
    if (frame.seq > this.#next || this.#starvedFrom !== undefined) {
      if (this.#starvedFrom === undefined) {
        host.metrics.gaps += 1;
        this.#requestResend(this.#next);
      }
      return;
    }
    // An empty queue always takes the next frame (a single frame may exceed the cap).
    if (this.#queue.length > 0 && this.#queuedBytes + bytes > this.#maxBytes) {
      this.#starvedFrom = this.#next; // resent once the queue drains
      return;
    }
    host.metrics.framesAccepted += 1;
    this.#queue.push({ frame, bytes });
    this.#queuedBytes += bytes;
    this.#next = frame.seq + 1;
    this.#wake?.();
    if (!this.#working) this.#start();
  }

  #start(): void {
    this.#working = true;
    // Nothing may reject unhandled out of a WebSocket handler: any failure is a failed batch.
    this.#work().catch((err: unknown) => {
      this.#working = false;
      this.#recover(err, this.#cursor);
    });
  }

  close(): void {
    this.#closed = true;
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#wake?.();
  }

  /** `force` for retries: a deduped retry could stall a run that has gone quiet. */
  #requestResend(from: number, force = false): void {
    const now = Date.now();
    // The agent re-sends everything after `from`; every later frame of the gap would ask again.
    const recent =
      this.#lastResend && this.#lastResend.from === from && now - this.#lastResend.at < 1_000;
    if (recent && !force) return;
    this.#lastResend = { from, at: now };
    this.#o.host.sendResend(this.#o.runId, from);
  }

  #takeOne(): Queued | undefined {
    const item = this.#queue.shift();
    if (item) this.#queuedBytes -= item.bytes;
    return item;
  }

  /** Waits for a frame or the window to pass, whichever is first. */
  #waitForMore(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = done;
    });
  }

  async #work(): Promise<void> {
    const { tuning, host } = this.#o;
    try {
      let frames: number[] = [];
      let events: NewRunEvent[] = [];
      let windowEnds = 0;
      while (!this.#closed && !this.#ended) {
        if (this.#queue.length === 0) {
          if (frames.length === 0) break;
          const left = windowEnds - Date.now();
          if (left > 0) {
            await this.#waitForMore(left);
            this.#wake = undefined;
            if (this.#queue.length > 0) continue;
          }
          await this.#flush(frames, events, false, false);
          frames = [];
          events = [];
          continue;
        }
        const item = this.#takeOne();
        if (!item) continue;
        if (frames.length === 0) windowEnds = Date.now() + tuning.batchWindowMs;
        const t = await this.#translator.translate(item.frame.seq, item.frame.event);
        if (t.invalid !== undefined) host.sendError("malformed_frame", t.invalid, "pi.event");
        if (t.dropped > 0) host.log.debug({ run_id: this.#o.runId }, "dropped invalid Pi output");
        frames.push(item.frame.seq);
        events.push(...t.events);
        const prompt =
          t.syncEntries ||
          t.settled ||
          frames.length >= tuning.batchMaxFrames ||
          events.length >= 2 * MAX_APPEND_BATCH ||
          t.events.some((e) => !DELTAS.has(e.type));
        if (prompt) {
          await this.#flush(frames, events, t.syncEntries || t.settled, t.settled);
          frames = [];
          events = [];
        }
      }
    } finally {
      this.#working = false;
      this.#wake = undefined;
    }
    if (
      !this.#closed &&
      !this.#ended &&
      this.#queue.length === 0 &&
      this.#starvedFrom !== undefined
    ) {
      this.#starvedFrom = undefined;
      this.#requestResend(this.#next, true);
    }
  }

  async #flush(frames: number[], events: NewRunEvent[], sync: boolean, settled: boolean) {
    const { db, teamId, runId, threadId, host } = this.#o;
    const translator = this.#translator;
    const first = frames[0];
    const last = frames[frames.length - 1];
    if (first === undefined || last === undefined) return;
    try {
      // Network I/O (get_entries) before the transaction, never inside it (KOBE-29/31).
      const entries = sync ? await this.#fetchEntries(settled) : undefined;
      const { runMaxEvents, runMaxBytes, threadMaxEntries } = this.#o.tuning;
      const ended = await withAppendTx(db, teamId, async (tx) => {
        const touchesThread = entries !== undefined || settled;
        if (touchesThread) {
          // Thread before run (KOBE-29 lock order): mirroring and ending both write the thread.
          await tx.execute(sql`
            SELECT 1 FROM threads WHERE team_id = ${teamId} AND id = ${threadId} FOR NO KEY UPDATE`);
        }
        const committed: NewRunEvent[] = [];
        let mirroredBytes = 0;
        if (entries !== undefined) {
          const mirrored = await mirrorEntriesInTx(tx, teamId, threadId, entries, threadMaxEntries);
          if (mirrored.capped) throw new LimitExceeded("thread_entries");
          mirroredBytes = mirrored.bytes;
          if (mirrored.orphans > 0) {
            host.log.warn(
              { run_id: runId, orphans: mirrored.orphans },
              "entries with unknown parents skipped",
            );
          }
          committed.push(
            ...entryCommittedEvents(mirrored.inserted, () => translator.takeCompletedMessageId()),
          );
        }
        const all = coalesceDeltas([...events, ...committed]);
        const bytes =
          mirroredBytes +
          all.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e.payload), "utf8"), 0);
        const cas = await tx.execute<{ last_seq: number; sandbox_bytes: number }>(sql`
          UPDATE runs SET sandbox_seq = ${last}, sandbox_bytes = sandbox_bytes + ${bytes}
           WHERE team_id = ${teamId} AND id = ${runId} AND sandbox_seq = ${first - 1}
             AND status IN ('running', 'waiting_approval')
          RETURNING last_seq, sandbox_bytes`);
        const counters = cas.rows[0];
        if (cas.rowCount !== 1 || !counters) {
          const now = await tx.execute<{ sandbox_seq: number; status: string }>(sql`
            SELECT sandbox_seq, status FROM runs WHERE team_id = ${teamId} AND id = ${runId}`);
          const row = now.rows[0];
          throw new CursorConflict(
            row?.sandbox_seq ?? 0,
            row?.status === "running" || row?.status === "waiting_approval",
          );
        }
        // Room is kept for the terminal event, so a run at its cap can still end visibly.
        if (counters.last_seq + all.length + 1 > runMaxEvents)
          throw new LimitExceeded("run_events");
        if (Number(counters.sandbox_bytes) > runMaxBytes) throw new LimitExceeded("run_bytes");
        for (let i = 0; i < all.length; i += MAX_APPEND_BATCH) {
          await appendRunEventsInTx(tx, teamId, runId, all.slice(i, i + MAX_APPEND_BATCH));
        }
        if (settled) {
          return (await endRunInTx(tx, teamId, runId, { status: "completed" })).ended;
        }
        return false;
      });
      host.metrics.writes += 1;
      this.#failures = 0;
      this.#cursor = last;
      host.sendAck(runId, last);
      if (settled) {
        this.#ended = true;
        host.runEnded(runId, ended ? "completed" : undefined);
      }
    } catch (err) {
      this.#recover(err, last);
    }
  }

  /**
   * Entries for a sync. Before the run completes a failed fetch is retried; if it still fails the
   * thread is flagged so its next run starts with a full sync (nothing is silently lost: Pi keeps
   * the entries and `get_entries since` fetches them later).
   */
  async #fetchEntries(settling: boolean): Promise<PiGetEntriesData | undefined> {
    const { host, threadId, runId } = this.#o;
    const attempts = settling ? SETTLE_SYNC_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const entries = await host.fetchNewEntries(threadId);
      if (entries !== undefined || this.#closed) return entries;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    if (settling) {
      host.log.warn({ run_id: runId, thread_id: threadId }, "entries not mirrored at run end");
      host.needsSync(threadId);
    }
    return undefined;
  }

  #recover(err: unknown, last: number): void {
    const { host, runId } = this.#o;
    if (err instanceof LimitExceeded) {
      // Nothing of the batch was stored. The run fails and is stopped; frames are acked so the
      // agent can forget them.
      this.#ended = true;
      this.#queue = [];
      this.#queuedBytes = 0;
      host.sendAck(runId, last);
      host.limitExceeded(runId, err.limit);
      return;
    }
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#starvedFrom = undefined;
    // The batch's translation (message ids, completed messages) was not committed.
    this.#translator = this.#o.createTranslator();
    if (err instanceof CursorConflict) {
      this.#cursor = err.cursor;
      this.#next = err.cursor + 1;
      if (!err.active) {
        // Ended elsewhere (Stop, sweep): late frames are acknowledged and not executed.
        this.#ended = true;
        host.sendError("run_not_active", "the run has ended", "pi.event");
        host.sendAck(runId, last);
        host.runEnded(runId, undefined);
        return;
      }
      if (last <= err.cursor) host.sendAck(runId, err.cursor);
      else this.#requestResend(this.#next);
      return;
    }
    this.#failures += 1;
    this.#next = this.#cursor + 1;
    host.log.warn({ err, run_id: runId, failures: this.#failures }, "sandbox ingest write failed");
    if (this.#failures >= this.#o.tuning.maxIngestFailures) {
      host.failed(err);
      return;
    }
    const retry = setTimeout(
      () => {
        if (!this.#closed && !this.#ended) this.#requestResend(this.#next, true);
      },
      250 * 2 ** this.#failures,
    );
    retry.unref();
  }
}
