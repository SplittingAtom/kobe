import { mkdir } from "node:fs/promises";
import {
  piExtensionUiRequestSchema,
  type PiExtensionUiRequest,
  type PiExtensionUiResponse,
  type PiRpcResponse,
} from "@kobe/protocol";
import {
  PolicyChannel,
  type PolicyChannelCheck,
  type PolicyChannelReply,
} from "../policy/channel.js";
import { PiProcess, PiProcessError, type PiExit, type PiRecord } from "../pi/pi-process.js";
import type { PiLaunch } from "../pi/pi-launch.js";
import { ensureSessionDir } from "../pi/session-files.js";

/**
 * One Kobe thread's Pi process and its active run. All lifecycle changes (spawn, restart, stop,
 * session-file writes) are serialised through `withLock`; Pi requests run outside the lock.
 */
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
export const MAX_PENDING_DIALOGS = 64;

export interface ThreadHooks {
  readonly runStarted: (runId: string, threadId: string) => void;
  readonly piEvent: (runId: string, threadId: string, event: PiRecord) => void;
  readonly runEnded: (runId: string, threadId: string) => void;
  readonly uiRequest: (
    threadId: string,
    runId: string | undefined,
    request: PiExtensionUiRequest,
  ) => void;
  readonly piExited: (threadId: string, exit: PiExit) => void;
  readonly policyCheck: (
    threadId: string,
    runId: string | undefined,
    check: PolicyChannelCheck,
    reply: (message: PolicyChannelReply) => void,
  ) => void;
  readonly diagnostic: (threadId: string, message: string) => void;
}

export interface ThreadEnv {
  readonly bin: string;
  readonly workspaceDir: string;
  readonly sessionDir: string;
  readonly home: string;
}

interface ActiveRun {
  readonly runId: string;
  stopAfterStep: boolean;
  stopping: boolean;
  readonly ended: Promise<void>;
  readonly resolveEnded: () => void;
}

export class Thread {
  readonly id: string;
  readonly #env: ThreadEnv;
  readonly #hooks: ThreadHooks;
  #pi: PiProcess | undefined;
  #launchKey: string | undefined;
  #closing = new Set<PiProcess>();
  #run: ActiveRun | undefined;
  #streaming = false;
  #dialogs = new Map<string, PiExtensionUiRequest>();
  #lock: Promise<unknown> = Promise.resolve();
  #inflight = 0;
  /** Commands in progress on this thread (taken synchronously when a command arrives). */
  #claims = 0;
  lastUsed = Date.now();
  restoring = false;

  constructor(id: string, env: ThreadEnv, hooks: ThreadHooks) {
    this.id = id;
    this.#env = env;
    this.#hooks = hooks;
  }

  get runId(): string | undefined {
    return this.#run?.runId;
  }

  get hasProcess(): boolean {
    return this.#pi !== undefined;
  }

  get launchKey(): string | undefined {
    return this.#launchKey;
  }

  get streaming(): boolean {
    return this.#streaming;
  }

  /** Busy threads are never evicted or reaped. */
  get busy(): boolean {
    return (
      this.#run !== undefined ||
      this.#streaming ||
      this.restoring ||
      this.#inflight > 0 ||
      this.#claims > 0
    );
  }

  /**
   * Mark the thread busy for the duration of a command, from the moment it arrives, so the reaper
   * and the process cap never stop (or forget) a thread a queued command is about to use.
   */
  claim(): () => void {
    this.#claims += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#claims -= 1;
    };
  }

  get pendingDialogs(): PiExtensionUiRequest[] {
    return [...this.#dialogs.values()];
  }

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(fn, fn);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  /** Spawn Pi with `launch` (call inside the lock). */
  async spawn(launch: PiLaunch): Promise<void> {
    await ensureSessionDir(this.#env.sessionDir);
    await mkdir(this.#env.home, { recursive: true }).catch(() => undefined);
    const pi = new PiProcess({
      bin: this.#env.bin,
      args: launch.args,
      cwd: this.#env.workspaceDir,
      env: launch.env,
      onEvent: (event) => this.#onEvent(pi, event),
      onUiRequest: (request) => this.#onUiRequest(pi, request),
      onExit: (exit) => this.#onExit(pi, exit),
      onDiagnostic: (message) => this.#hooks.diagnostic(this.id, message),
    });
    const control = pi.control;
    if (control !== undefined) {
      const channel = new PolicyChannel(control, {
        onCheck: (check) =>
          this.#hooks.policyCheck(this.id, this.#run?.runId, check, (m) => channel.reply(m)),
        onDiagnostic: (message) => this.#hooks.diagnostic(this.id, message),
      });
    }
    this.#pi = pi;
    this.#launchKey = launch.key;
    this.lastUsed = Date.now();
  }

  /** Stop the Pi process (call inside the lock). Ends the active run, if any. */
  async stopProcess(): Promise<void> {
    const pi = this.#pi;
    if (pi === undefined) return;
    this.#closing.add(pi);
    this.#detach(pi);
    await pi.close();
  }

  /** Synchronous kill for agent exit. */
  kill(): void {
    this.#pi?.kill();
  }

  async request(command: Record<string, unknown>, timeoutMs: number): Promise<PiRpcResponse> {
    const pi = this.#pi;
    if (pi === undefined) throw new PiProcessError("Pi process is not running", "pi_unavailable");
    this.lastUsed = Date.now();
    this.#inflight += 1;
    try {
      return await pi.request(command, timeoutMs);
    } finally {
      this.#inflight -= 1;
      this.lastUsed = Date.now();
    }
  }

  beginRun(runId: string): void {
    let resolveEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    this.#run = { runId, stopAfterStep: false, stopping: false, ended, resolveEnded };
    this.onStopDue = undefined;
    this.lastUsed = Date.now();
    this.#hooks.runStarted(runId, this.id);
  }

  endRun(): void {
    const run = this.#run;
    if (run === undefined) return;
    this.#run = undefined;
    this.lastUsed = Date.now();
    this.#hooks.runEnded(run.runId, this.id);
    run.resolveEnded();
  }

  runEnded(): Promise<void> {
    return this.#run?.ended ?? Promise.resolve();
  }

  /** Stop after the in-flight step (`turn_end`); returns true when an abort is due now. */
  markStopAfterStep(): boolean {
    const run = this.#run;
    if (run === undefined) return false;
    run.stopAfterStep = true;
    return !this.#streaming;
  }

  /** Mark the run as stopping; false when a stop is already under way. */
  beginStopping(): boolean {
    const run = this.#run;
    if (run === undefined || run.stopping) return false;
    run.stopping = true;
    return true;
  }

  answerDialog(response: PiExtensionUiResponse): boolean {
    if (!this.#dialogs.delete(response.id)) return false;
    this.#pi?.send(response);
    return true;
  }

  /** Called when an abort is due after `turn_end`; set by the manager. */
  onStopDue: (() => void) | undefined;

  #onEvent(pi: PiProcess, event: PiRecord): void {
    if (pi !== this.#pi) return;
    this.lastUsed = Date.now();
    if (event.type === "agent_start") this.#streaming = true;
    const run = this.#run;
    if (run !== undefined) this.#hooks.piEvent(run.runId, this.id, event);
    if (event.type === "turn_end" && run?.stopAfterStep === true && !run.stopping) {
      this.onStopDue?.();
    }
    if (event.type === "agent_settled") {
      this.#streaming = false;
      if (run !== undefined && this.#run === run) this.endRun();
    }
  }

  #onUiRequest(pi: PiProcess, record: PiRecord): void {
    if (pi !== this.#pi) return;
    const parsed = piExtensionUiRequestSchema.safeParse(record);
    if (!parsed.success) {
      const id = typeof record.id === "string" ? record.id : undefined;
      if (id !== undefined) pi.send({ type: "extension_ui_response", id, cancelled: true });
      this.#hooks.diagnostic(this.id, "unsupported extension UI request cancelled");
      return;
    }
    const request = parsed.data;
    if (DIALOG_METHODS.has(request.method)) {
      if (this.#dialogs.size >= MAX_PENDING_DIALOGS) {
        pi.send({ type: "extension_ui_response", id: request.id, cancelled: true });
        return;
      }
      this.#dialogs.set(request.id, request);
    }
    this.#hooks.uiRequest(this.id, this.#run?.runId, request);
  }

  #onExit(pi: PiProcess, exit: PiExit): void {
    const expected = this.#closing.delete(pi);
    if (pi === this.#pi) this.#detach(pi);
    if (!expected) this.#hooks.piExited(this.id, exit);
  }

  #detach(pi: PiProcess): void {
    if (pi !== this.#pi) return;
    this.#pi = undefined;
    this.#launchKey = undefined;
    this.#streaming = false;
    this.#dialogs.clear();
    this.endRun();
  }
}
