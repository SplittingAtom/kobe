import type { Readable, Writable } from "node:stream";
import { LineSplitter } from "../jsonl.js";

/**
 * One running `kobe-kernel-bridge.py` (images/sandbox/kernel; docs/specs/notebooks.md NB10): the
 * agent's end of its stdio JSON-lines protocol. One execution at a time; the manager queues.
 */
export interface BridgeProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  /** Ends the bridge and its kernel (and, under an identity, everything of that uid). */
  kill(): Promise<void>;
}

/** Starts a bridge for a thread's kernel. */
export type BridgeLauncher = (threadId: string) => Promise<BridgeProcess>;

export type BridgeEvent =
  | { readonly ev: "ready" }
  | { readonly ev: "output"; readonly id: string; readonly output: unknown }
  | {
      readonly ev: "done";
      readonly id: string;
      readonly status: "ok" | "error" | "interrupted";
      readonly execution_count: number | null;
    }
  | { readonly ev: "died" }
  | { readonly ev: "fatal"; readonly message: string };

/** The bridge prints at most this much per line (it shrinks larger outputs itself). */
export const BRIDGE_MAX_LINE_BYTES = 2 * 1024 * 1024;

export function parseBridgeLine(line: string): BridgeEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const m = value as Record<string, unknown>;
  switch (m.ev) {
    case "ready":
    case "died":
      return { ev: m.ev };
    case "fatal":
      return { ev: "fatal", message: String(m.message ?? "").slice(0, 500) };
    case "output":
      return typeof m.id === "string" ? { ev: "output", id: m.id, output: m.output } : undefined;
    case "done": {
      const status = m.status;
      if (typeof m.id !== "string") return undefined;
      if (status !== "ok" && status !== "error" && status !== "interrupted") return undefined;
      const count = m.execution_count;
      return {
        ev: "done",
        id: m.id,
        status,
        execution_count: typeof count === "number" && Number.isInteger(count) ? count : null,
      };
    }
    default:
      return undefined;
  }
}

/** How an execution ended, as the bridge saw it; `gone`: the bridge or kernel went away. */
export type SessionResult =
  | {
      readonly kind: "done";
      readonly status: "ok" | "error" | "interrupted";
      readonly executionCount: number | null;
    }
  | { readonly kind: "gone"; readonly message: string };

interface Running {
  readonly id: string;
  readonly onOutput: (output: unknown) => void;
  readonly resolve: (result: SessionResult) => void;
}

export class KernelSession {
  readonly #proc: BridgeProcess;
  readonly #diagnostic: (message: string) => void;
  #ready: Promise<void>;
  #running: Running | undefined;
  #goneReason: string | undefined;
  #stopping: Promise<void> | undefined;
  #onReady: { resolve: () => void; reject: (error: Error) => void } | undefined;

  constructor(proc: BridgeProcess, diagnostic: (message: string) => void) {
    this.#proc = proc;
    this.#diagnostic = diagnostic;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#onReady = { resolve, reject };
    });
    // A rejection nobody awaited yet must not crash the agent.
    this.#ready.catch(() => undefined);
    const splitter = new LineSplitter({
      maxLineBytes: BRIDGE_MAX_LINE_BYTES,
      onLine: (line) => this.#onLine(line),
      onOversize: (bytes) => this.#diagnostic(`kernel bridge line of ${bytes} bytes dropped`),
    });
    proc.stdout.on("data", (chunk: Buffer) => splitter.push(chunk));
    proc.stdout.on("error", () => undefined);
    proc.stdin.on("error", () => undefined);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    proc.stderr.on("error", () => undefined);
    void proc.exited.then(({ code, signal }) => {
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      this.#gone(`the kernel bridge exited (${signal ?? code})${tail ? `: ${tail}` : ""}`);
    });
  }

  get alive(): boolean {
    return this.#goneReason === undefined;
  }

  get busy(): boolean {
    return this.#running !== undefined;
  }

  /** Resolves once the kernel answered; rejects if the bridge fails first or `timeoutMs` passes. */
  ready(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the kernel did not start in time")), timeoutMs);
    });
    return Promise.race([this.#ready, timeout]).finally(() => clearTimeout(timer));
  }

  execute(id: string, code: string, onOutput: (output: unknown) => void): Promise<SessionResult> {
    if (this.#goneReason !== undefined) {
      return Promise.resolve({ kind: "gone", message: this.#goneReason });
    }
    if (this.#running !== undefined) throw new Error("the kernel is busy");
    return new Promise<SessionResult>((resolve) => {
      this.#running = { id, onOutput, resolve };
      this.#write({ op: "execute", id, code });
    });
  }

  interrupt(): void {
    this.#write({ op: "interrupt" });
  }

  /** Stops the bridge (and its kernel); a running execution ends `gone`. Idempotent. */
  stop(reason: string): Promise<void> {
    this.#stopping ??= (async () => {
      this.#write({ op: "shutdown" });
      this.#proc.stdin.end();
      this.#gone(reason);
      await this.#proc.kill();
    })();
    return this.#stopping;
  }

  #write(message: Record<string, unknown>): void {
    if (this.#goneReason !== undefined || this.#proc.stdin.writableEnded) return;
    this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line: string): void {
    const event = parseBridgeLine(line);
    if (event === undefined) {
      this.#diagnostic("malformed line from the kernel bridge");
      return;
    }
    switch (event.ev) {
      case "ready":
        this.#onReady?.resolve();
        return;
      case "fatal":
        this.#diagnostic(`kernel bridge: ${event.message}`);
        if (this.#running === undefined) this.#onReady?.reject(new Error(event.message));
        return;
      case "died":
        this.#gone("the kernel stopped");
        return;
      case "output":
        if (this.#running?.id === event.id) this.#running.onOutput(event.output);
        return;
      case "done": {
        const running = this.#running;
        if (running?.id !== event.id) return;
        this.#running = undefined;
        running.resolve({
          kind: "done",
          status: event.status,
          executionCount: event.execution_count,
        });
        return;
      }
    }
  }

  #gone(reason: string): void {
    if (this.#goneReason !== undefined) return;
    this.#goneReason = reason;
    this.#onReady?.reject(new Error(reason));
    const running = this.#running;
    this.#running = undefined;
    running?.resolve({ kind: "gone", message: reason });
  }
}
