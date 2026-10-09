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
import { descendantPids, killPids } from "./descendants.js";
import type { PiIdentities, PiIdentity } from "./identities.js";

/**
 * One `pi --mode rpc` child process (verified Pi 1.0.0 RPC semantics, packages/protocol pi-rpc.ts):
 * JSONL on stdin/stdout split on LF only, responses correlated by the `id` the agent assigns, session
 * events and `extension_ui_request` records uncorrelated. fd 3 is a socket pair for the kobe-policy
 * extension (see policy/channel.ts for what tools can and cannot reach); nothing listens anywhere.
 *
 * The child runs in its own process group. Pi starts its tools in their own groups too, so a stop
 * also kills Pi's descendants: under a Pi identity (KOBE-71) every process of its uid (exact:
 * nothing else runs as that uid), otherwise those found through /proc (best effort, see
 * descendants.ts).
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
  /**
   * Start Pi as this identity through the helper (KOBE-71). The agent cannot signal a process of
   * another uid, so stopping goes through the helper too.
   */
  readonly runAs?: { readonly identities: PiIdentities; readonly identity: PiIdentity };
  /** Also give Pi a fifth pipe as fd 4: the kobe-tools channel (KOBE-128). */
  readonly toolsChannel?: boolean;
  /** Also give Pi a sixth pipe as fd 5: the kobe-exec channel (KOBE-167). */
  readonly execChannel?: boolean;
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
    const runAs = options.runAs;
    const [file, args] =
      runAs === undefined
        ? [options.bin, [...options.args]]
        : [
            runAs.identities.helper,
            [...runAs.identities.command(runAs.identity, options.bin, options.args, options.env)],
          ];
    this.#child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...options.env },
      // fd 3 policy, fd 4 kobe-tools, fd 5 kobe-exec; a channel in use needs the ones before it.
      stdio:
        options.execChannel === true
          ? ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
          : options.toolsChannel === true
            ? ["pipe", "pipe", "pipe", "pipe", "pipe"]
            : ["pipe", "pipe", "pipe", "pipe"],
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
    this.toolsControl?.on("error", () => undefined);
    this.execControl?.on("error", () => undefined);

    this.#exited = new Promise((resolve) => {
      const finish = (exitCode: number | null, signal: string | null) => {
        if (this.#exit !== undefined) return;
        this.#exit = { exitCode, signal, stderrTail: this.#stderrTail };
        this.#failPending(new PiProcessError("Pi process exited", "pi_unavailable"));
        this.control?.destroy();
        this.toolsControl?.destroy();
        this.execControl?.destroy();
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

  /** fd 4 of the child: the kobe-tools channel (only with `toolsChannel`). */
  get toolsControl(): Duplex | undefined {
    if (this.#options.toolsChannel !== true) return undefined;
    return (this.#child.stdio[4] as Duplex | null | undefined) ?? undefined;
  }

  /** fd 5 of the child: the kobe-exec channel (only with `execChannel`). */
  get execControl(): Duplex | undefined {
    if (this.#options.execChannel !== true) return undefined;
    return (
      ((this.#child.stdio as (Duplex | null | undefined)[])[5] as Duplex | null | undefined) ??
      undefined
    );
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
    const runAs = this.#options.runAs;
    if (runAs !== undefined) return this.#closeAs(runAs.identities, runAs.identity, graceMs);
    // Tools Pi started in their own process groups escape the group signal: note them while Pi is
    // alive (afterwards they are re-parented and unattributable) and kill whatever is left.
    const tools = new Set(this.#descendants());
    this.#child.stdin?.end();
    const exited = await this.#waitExit(graceMs);
    if (!exited) {
      for (const pid of this.#descendants()) tools.add(pid);
      this.#signalGroup("SIGTERM");
      if (!(await this.#waitExit(2000))) this.#signalGroup("SIGKILL");
    }
    const exit = await this.#exited;
    killPids([...tools]);
    return exit;
  }

  /**
   * Under a Pi identity: close stdin, SIGTERM Pi's group, then SIGKILL every process of the uid
   * (Pi and all its tools, whatever group they moved to).
   */
  async #closeAs(identities: PiIdentities, identity: PiIdentity, graceMs: number): Promise<PiExit> {
    this.#child.stdin?.end();
    const pid = this.#child.pid;
    if (!(await this.#waitExit(graceMs)) && pid !== undefined) {
      await identities.signalGroup(identity, pid, "TERM");
      await this.#waitExit(2000);
    }
    await identities.killAll(identity).catch((error: unknown) => {
      this.#options.onDiagnostic?.(`stopping Pi: ${(error as Error).message}`);
    });
    if (await this.#waitExit(5000)) return this.#exited;
    // The helper could not stop it: report it gone from the agent's side; its identity stays in
    // use (never handed to another thread) because the exit handler that reclaims it never runs.
    this.#options.onDiagnostic?.("Pi did not exit after kill-all; its identity stays reserved");
    return { exitCode: null, signal: null, stderrTail: this.#stderrTail };
  }

  /** Synchronous last resort (agent exit). */
  kill(): void {
    if (this.#exit !== undefined) return;
    const runAs = this.#options.runAs;
    if (runAs !== undefined) {
      runAs.identities.killAllSync(runAs.identity);
      return;
    }
    const tools = this.#descendants();
    this.#signalGroup("SIGKILL");
    killPids(tools);
  }

  #descendants(): number[] {
    const pid = this.#child.pid;
    return pid === undefined ? [] : descendantPids(pid);
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
