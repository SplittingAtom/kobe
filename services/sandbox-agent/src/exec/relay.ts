import type { Duplex, Readable, Writable } from "node:stream";
import { LineSplitter } from "../jsonl.js";
import {
  MAX_PENDING_REQUESTS,
  MAX_REPLY_LINE_BYTES,
  MAX_REQUEST_LINE_BYTES,
  OP_CANCEL,
  errorFrame,
  parseEnvelope,
  parseReply,
  type FinalFrame,
} from "../kobe-exec/protocol.js";
import { sanitizeString } from "../sanitize.js";

/**
 * Agent end of the exec channel (KOBE-167; fd 5 of each `pi --mode rpc`, see kobe-exec/protocol.ts).
 * It relays frames between the kobe-exec extension in Pi and the thread's executor, a process
 * running as the Pi identity's partner uid, so Pi never touches a tool and the tool uid never
 * touches Pi's end: both are pipes the agent made, nothing listens, and no path leads from one
 * to the other except through here.
 *
 * What it enforces: line size limits both ways, a well-formed id and a known op on every request,
 * at most {@link MAX_PENDING_REQUESTS} open requests, replies only for open requests. Fail
 * closed: when the executor cannot be started or dies, every open request is answered with an
 * `unavailable` error and the next request starts a fresh executor; when the channel itself is
 * unusable (oversize line, write failure) it is closed and the extension fails every call. Nothing
 * is ever executed on the Pi side of the relay.
 *
 * The executor is started lazily on the first request (one extra Node process per live Pi only
 * for threads that use tools) and killed with the relay.
 */
export interface ExecutorHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Resolves once the process is gone. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  /** SIGKILL it (and, where it can, whatever it started). */
  kill(): void;
}

export interface ExecRelayOptions {
  /** The agent's end of Pi's fd 5. */
  readonly channel: Duplex;
  /** Start an executor (after clearing the previous one's leftovers). Rejects when it cannot. */
  readonly startExecutor: () => Promise<ExecutorHandle>;
  readonly onClosed?: (reason: string) => void;
  readonly onDiagnostic?: (message: string) => void;
}

/** Bytes buffered towards a peer that does not read before the relay gives up on it. */
export const EXEC_MAX_WRITE_BUFFER = 16 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2048;

interface Active {
  readonly handle: ExecutorHandle;
  stderrTail: string;
  dead: boolean;
}

export class ExecRelay {
  readonly #options: ExecRelayOptions;
  readonly #open = new Set<string>();
  #active: Promise<Active> | undefined;
  #current: Active | undefined;
  #closedReason: string | undefined;

  constructor(options: ExecRelayOptions) {
    this.#options = options;
    const splitter = new LineSplitter({
      maxLineBytes: MAX_REQUEST_LINE_BYTES,
      onLine: (line) => this.#onPiLine(line),
      onOversize: () => this.close("oversize exec request"),
    });
    options.channel.on("data", (chunk: Buffer) => {
      if (this.#closedReason === undefined) splitter.push(chunk);
    });
    options.channel.on("error", () => undefined);
    options.channel.on("close", () => this.close("exec channel closed"));
  }

  get closed(): boolean {
    return this.#closedReason !== undefined;
  }

  /** Stop relaying: the executor is killed, the channel destroyed. Idempotent. */
  close(reason: string): void {
    if (this.#closedReason !== undefined) return;
    this.#closedReason = reason;
    this.#open.clear();
    const active = this.#active;
    this.#active = undefined;
    this.#current = undefined;
    void active?.then(
      (a) => this.#kill(a),
      () => undefined,
    );
    this.#options.channel.destroy();
    this.#options.onClosed?.(reason);
  }

  #toPi(frame: FinalFrame | Record<string, unknown>): void {
    this.#writeToPi(`${JSON.stringify(frame)}\n`);
  }

  /** Returns false when Pi's side is saturated. */
  #writeToPi(line: string): boolean {
    const { channel } = this.#options;
    if (this.#closedReason !== undefined || channel.destroyed || !channel.writable) return true;
    if (channel.writableLength > EXEC_MAX_WRITE_BUFFER) {
      this.close("exec channel reader is not reading");
      return true;
    }
    return channel.write(line);
  }

  #fail(id: string, message: string): void {
    if (this.#open.delete(id)) this.#toPi(errorFrame(id, "unavailable", message));
  }

  #onPiLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.close("malformed exec request");
      return;
    }
    const envelope = parseEnvelope(value);
    if (envelope === undefined) {
      this.close("malformed exec request");
      return;
    }
    const { id, op } = envelope;
    if (op === OP_CANCEL) {
      this.#forward(line, undefined);
      return;
    }
    if (this.#open.has(id)) {
      this.#toPi(errorFrame(id, "invalid", "duplicate request id"));
      return;
    }
    if (this.#open.size >= MAX_PENDING_REQUESTS) {
      this.#toPi(errorFrame(id, "unavailable", "too many requests in flight"));
      return;
    }
    this.#open.add(id);
    this.#forward(line, id);
  }

  /** Send `line` to the executor, starting one if needed. `id`: fail this request if that fails. */
  #forward(line: string, id: string | undefined): void {
    if (id === undefined && this.#active === undefined) return; // a cancel with nothing to cancel
    this.#active ??= this.#start();
    void this.#active.then(
      (active) => {
        if (active.dead || this.#closedReason !== undefined) {
          if (id !== undefined) this.#fail(id, "the tool executor is not running");
          return;
        }
        active.handle.stdin.write(`${line}\n`, (error) => {
          if (error && id !== undefined) this.#fail(id, "cannot write to the tool executor");
        });
        if (active.handle.stdin.writableLength > EXEC_MAX_WRITE_BUFFER) {
          this.#options.onDiagnostic?.("tool executor is not reading; killing it");
          this.#kill(active);
        }
      },
      (error: unknown) => {
        if (id !== undefined) this.#fail(id, `cannot start the tool executor: ${message(error)}`);
      },
    );
  }

  async #start(): Promise<Active> {
    let handle: ExecutorHandle;
    try {
      handle = await this.#options.startExecutor();
    } catch (error) {
      this.#active = undefined;
      throw error;
    }
    const active: Active = { handle, stderrTail: "", dead: false };
    this.#current = active;
    if (this.#closedReason !== undefined) {
      handle.kill();
      active.dead = true;
      return active;
    }
    const splitter = new LineSplitter({
      maxLineBytes: MAX_REPLY_LINE_BYTES,
      onLine: (line) => this.#onExecutorLine(active, line),
      onOversize: () => {
        this.#options.onDiagnostic?.("oversize reply from the tool executor; killing it");
        this.#kill(active);
      },
    });
    handle.stdout.on("data", (chunk: Buffer) => {
      if (!active.dead) splitter.push(chunk);
    });
    handle.stdout.on("error", () => undefined);
    handle.stdin.on("error", () => undefined);
    handle.stderr.setEncoding("utf8");
    handle.stderr.on("data", (text: string) => {
      active.stderrTail = sanitizeString(active.stderrTail + text).slice(-STDERR_TAIL_CHARS);
    });
    handle.stderr.on("error", () => undefined);
    void handle.exited.then((exit) => this.#onExecutorExit(active, exit));
    return active;
  }

  #onExecutorLine(active: Active, line: string): void {
    if (active.dead) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#options.onDiagnostic?.("tool executor sent a non-JSON line; killing it");
      this.#kill(active);
      return;
    }
    const reply = parseReply(value);
    if (reply === undefined || !this.#open.has(reply.id)) {
      this.#options.onDiagnostic?.("tool executor sent a reply for no open request; dropped");
      return;
    }
    if (reply.final) this.#open.delete(reply.id);
    if (!this.#writeToPi(`${line}\n`)) {
      // Pi is not keeping up: stop reading the executor until it has.
      active.handle.stdout.pause();
      this.#options.channel.once("drain", () => active.handle.stdout.resume());
    }
  }

  #onExecutorExit(
    active: Active,
    exit: { readonly code: number | null; readonly signal: string | null },
  ): void {
    active.dead = true;
    if (this.#closedReason !== undefined) return;
    // The next request starts a fresh one (after the starter clears this one's leftovers).
    if (this.#current === active) {
      this.#current = undefined;
      this.#active = undefined;
    }
    const how = exit.signal !== null ? `signal ${exit.signal}` : `code ${String(exit.code)}`;
    const tail = active.stderrTail.trim();
    const reason = `the tool executor exited (${how})${tail === "" ? "" : `: ${tail}`}`;
    this.#options.onDiagnostic?.(reason);
    for (const id of [...this.#open]) this.#fail(id, reason);
  }

  #kill(active: Active): void {
    active.dead = true;
    active.handle.kill();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
