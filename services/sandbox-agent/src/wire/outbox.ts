/**
 * Per-run outbound `pi.event` sequencing and the un-acked buffer (connection.ts "Delivery and
 * resume"). Seqs start at 1 per run and are gapless; a frame stays buffered until the server's
 * cumulative `ack` covers it. Memory is bounded: when the total un-acked bytes would exceed the
 * limit, the append fails and the caller gives the run up (aborts Pi, drops the run; the server
 * then interrupts it, D14).
 */
export interface OutboxRun {
  readonly runId: string;
  readonly threadId: string;
  lastSeq: number;
  ackedSeq: number;
  /** Pi is done with the run; it is forgotten once every frame is acked. */
  finished: boolean;
  readonly frames: { seq: number; text: string; bytes: number }[];
  /** Last `resend` served on this connection, to ignore its duplicates. */
  lastResend: { from: number; through: number } | undefined;
}

export type AppendResult =
  | { readonly ok: true; readonly seq: number; readonly text: string }
  | { readonly ok: false; readonly reason: "overflow" | "unknown_run" };

export class Outbox {
  readonly #runs = new Map<string, OutboxRun>();
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get bytes(): number {
    return this.#bytes;
  }

  has(runId: string): boolean {
    return this.#runs.has(runId);
  }

  get(runId: string): OutboxRun | undefined {
    return this.#runs.get(runId);
  }

  runIds(): string[] {
    return [...this.#runs.keys()];
  }

  open(runId: string, threadId: string): void {
    if (this.#runs.has(runId)) return;
    this.#runs.set(runId, {
      runId,
      threadId,
      lastSeq: 0,
      ackedSeq: 0,
      finished: false,
      frames: [],
      lastResend: undefined,
    });
  }

  /** Assign the next seq and buffer the encoded frame built for it. */
  append(runId: string, encode: (seq: number) => string): AppendResult {
    const run = this.#runs.get(runId);
    if (run === undefined) return { ok: false, reason: "unknown_run" };
    const seq = run.lastSeq + 1;
    const text = encode(seq);
    const bytes = Buffer.byteLength(text);
    if (this.#bytes + bytes > this.#maxBytes) return { ok: false, reason: "overflow" };
    run.lastSeq = seq;
    run.frames.push({ seq, text, bytes });
    this.#bytes += bytes;
    return { ok: true, seq, text };
  }

  /** Cumulative ack. Acks beyond what was sent are ignored (returns false). */
  ack(runId: string, seq: number): boolean {
    const run = this.#runs.get(runId);
    if (run === undefined || seq > run.lastSeq) return false;
    if (seq > run.ackedSeq) run.ackedSeq = seq;
    let drop = 0;
    while (drop < run.frames.length && (run.frames[drop]?.seq ?? Infinity) <= seq) {
      this.#bytes -= run.frames[drop]?.bytes ?? 0;
      drop += 1;
    }
    if (drop > 0) run.frames.splice(0, drop);
    this.#forgetIfDone(run);
    return true;
  }

  /** Frames to re-send from `fromSeq`; empty when this resend duplicates one already served. */
  resend(runId: string, fromSeq: number): string[] {
    const run = this.#runs.get(runId);
    if (run === undefined || fromSeq > run.lastSeq) return [];
    const last = run.lastResend;
    if (last !== undefined && fromSeq >= last.from && fromSeq <= last.through) return [];
    const frames = run.frames.filter((f) => f.seq >= fromSeq);
    run.lastResend = { from: fromSeq, through: run.lastSeq };
    return frames.map((f) => f.text);
  }

  /** New connection: `resend` bookkeeping is per connection. */
  resetConnectionState(): void {
    for (const run of this.#runs.values()) run.lastResend = undefined;
  }

  finish(runId: string): void {
    const run = this.#runs.get(runId);
    if (run === undefined) return;
    run.finished = true;
    this.#forgetIfDone(run);
  }

  drop(runId: string): void {
    const run = this.#runs.get(runId);
    if (run === undefined) return;
    for (const frame of run.frames) this.#bytes -= frame.bytes;
    this.#runs.delete(runId);
  }

  /** `hello.runs`: every run with a live Pi run or un-acked frames, and its highest sent seq. */
  helloRuns(): { run_id: string; thread_id: string; last_seq: number }[] {
    return [...this.#runs.values()].map((run) => ({
      run_id: run.runId,
      thread_id: run.threadId,
      last_seq: run.lastSeq,
    }));
  }

  #forgetIfDone(run: OutboxRun): void {
    if (run.finished && run.frames.length === 0) this.#runs.delete(run.runId);
  }
}
