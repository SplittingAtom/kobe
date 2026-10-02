import { spawn, type ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import {
  piRpcResponseSchema,
  piSessionEventSchema,
  type JsonValue,
  type PiRpcResponse,
} from "@kobe/protocol";
import { LineSplitter, encodeJsonl } from "../jsonl.js";
import { parsePiRecord, sanitizeString } from "../sanitize.js";

/**
 * One `pi --mode rpc` child process (verified Pi 1.0.0 RPC semantics, packages/protocol pi-rpc.ts):
 * JSONL on stdin/stdout split on LF only, responses correlated by the `id` the agent assigns, session
 * events and `extension_ui_request` records uncorrelated. fd 3 is a private socket pair for the
 * kobe-policy extension (see policy-channel.ts); nothing listens anywhere.
 *
 * The child runs in its own process group so a stop also reaps the tools Pi spawned.
 */
export const STDERR_TAIL_CHARS = 8192;
export const PI_MAX_LINE_BYTES = 32 * 1024 * 1024;

export interface PiExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderrTail: string;
}

export type PiRecord = Record<string, JsonValue> & { readonly type: string };

export interface PiProcessOptions {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The complete child environment (never inherited from the agent). */
  readonly env: Readonly<Record<string, string>>;
  readonly onEvent: (event: PiRecord) => void;
  readonly onUiRequest: (request: PiRecord) => void;
  readonly onExit: (exit: PiExit) => void;
  readonly onDiagnostic?: (message: string) => void;
  readonly maxLineBytes?: number;
}

interface Pending {
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class PiProcessError extends Error {
  constructor(
    message: string,
    readonly code: "pi_unavailable" | "timeout",
  ) {
    super(message);
  }
}

export class PiProcess {
  readonly #child: ChildProcess;
  readonly #options: PiProcessOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #exited: Promise<PiExit>;
  #exit: PiExit | undefined;
  #stderrTail = "";
  #nextId = 1;

  constructor(options: PiProcessOptions) {
    this.#options = options;
    this.#child = spawn(options.bin, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    const splitter = new LineSplitter({
      maxLineBytes: options.maxLineBytes ?? PI_MAX_LINE_BYTES,
      onLine: (line) => this.#onLine(line),
      onOversize: (bytes) => options.onDiagnostic?.(`dropped oversize Pi record (${bytes} bytes)`),
    });
    this.#child.stdout?.on("data", (chunk: Buffer) => splitter.push(chunk));
    this.#child.stdout?.on("end", () => splitter.end());
    this.#child.stderr?.setEncoding("utf8");
    this.#child.stderr?.on("data", (text: string) => this.#appendStderr(text));
    // EPIPE after the child died surfaces here; the exit handler reports it.
    this.#child.stdin?.on("error", () => undefined);
    this.control?.on("error", () => undefined);

    this.#exited = new Promise((resolve) => {
      const finish = (exitCode: number | null, signal: string | null) => {
        if (this.#exit !== undefined) return;
        this.#exit = { exitCode, signal, stderrTail: this.#stderrTail };
        this.#failPending(new PiProcessError("Pi process exited", "pi_unavailable"));
        this.control?.destroy();
        resolve(this.#exit);
        options.onExit(this.#exit);
      };
      this.#child.on("error", (error) => {
        this.#appendStderr(`spawn failed: ${error.message}\n`);
        finish(null, null);
      });
      this.#child.on("exit", (code, signal) => finish(code, signal));
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get exited(): boolean {
    return this.#exit !== undefined;
  }

  /** fd 3 of the child: the kobe-policy channel. */
  get control(): Duplex | undefined {
    return (this.#child.stdio[3] as Duplex | null | undefined) ?? undefined;
  }

  whenExited(): Promise<PiExit> {
    return this.#exited;
  }

  /** Send a command and wait for its correlated response. The agent owns the `id`. */
  request(command: Record<string, unknown>, timeoutMs: number): Promise<PiRpcResponse> {
    if (this.#exit !== undefined) {
      return Promise.reject(new PiProcessError("Pi process is not running", "pi_unavailable"));
    }
    const id = `k${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new PiProcessError(`Pi did not answer ${String(command.type)}`, "timeout"));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ ...command, id });
    });
  }

  /** Fire-and-forget record (extension UI responses). */
  send(record: Record<string, unknown>): void {
    if (this.#exit === undefined) this.#write(record);
  }

  /**
   * Orderly stop: close stdin (Pi disposes and exits), then SIGTERM, then SIGKILL the whole
   * process group.
   */
  async close(graceMs = 3000): Promise<PiExit> {
    if (this.#exit !== undefined) return this.#exit;
    this.#child.stdin?.end();
    if (await this.#waitExit(graceMs)) return this.#exited;
    this.#signalGroup("SIGTERM");
    if (await this.#waitExit(2000)) return this.#exited;
    this.#signalGroup("SIGKILL");
    return this.#exited;
  }

  /** Synchronous last resort (agent exit). */
  kill(): void {
    if (this.#exit === undefined) this.#signalGroup("SIGKILL");
  }

  #signalGroup(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.#child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  async #waitExit(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const done = await Promise.race([this.#exited.then(() => true as const), timeout]);
    clearTimeout(timer);
    return done;
  }

  #write(record: Record<string, unknown>): void {
    this.#child.stdin?.write(encodeJsonl(record));
  }

  #appendStderr(text: string): void {
    this.#stderrTail = sanitizeString(this.#stderrTail + text).slice(-STDERR_TAIL_CHARS);
  }

  #failPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  #onLine(line: string): void {
    const record = parsePiRecord(line);
    if (record === undefined) {
      this.#options.onDiagnostic?.("ignored a non-JSON-object line on Pi stdout");
      return;
    }
    if (record.type === "response") {
      this.#onResponse(record);
      return;
    }
    const event = piSessionEventSchema.safeParse(record);
    if (!event.success) {
      this.#options.onDiagnostic?.("ignored a Pi record without a valid type");
      return;
    }
    const typed = record as PiRecord;
    if (typed.type === "extension_ui_request") this.#options.onUiRequest(typed);
    else this.#options.onEvent(typed);
  }

  #onResponse(record: Record<string, JsonValue>): void {
    const parsed = piRpcResponseSchema.safeParse(record);
    if (!parsed.success) {
      this.#options.onDiagnostic?.("ignored a malformed Pi response");
      return;
    }
    const response = parsed.data;
    const pending = response.id === undefined ? undefined : this.#pending.get(response.id);
    if (pending === undefined || response.id === undefined) {
      this.#options.onDiagnostic?.(`uncorrelated Pi response to ${response.command}`);
      return;
    }
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }
}
