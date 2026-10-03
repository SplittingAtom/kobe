import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
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
import { MODEL_FILE_ENV } from "../kobe-models/protocol.js";
import { ModelFile } from "../models/model-file.js";
import type { ModelWiring, RunModel } from "../models/types.js";

/**
 * One Kobe thread's Pi process and its active run. All lifecycle changes (spawn, restart, stop,
 * session-file writes) are serialised through `withLock`; Pi requests run outside the lock.
 */
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
export const MAX_PENDING_DIALOGS = 64;
/** Pi startup (extension loading, jiti) up to kobe-policy's `channel.ready`. */
export const POLICY_READY_TIMEOUT_MS = 30_000;

export interface ThreadHooks {
  readonly runStarted: (runId: string, threadId: string) => void;
  readonly piEvent: (runId: string, threadId: string, event: PiRecord) => void;
  readonly runEnded: (runId: string, threadId: string) => void;
  readonly uiRequest: (
    threadId: string,
    runId: string | undefined,
    request: PiExtensionUiRequest,
  ) => void;
  /** `runId`: the run that was active when Pi exited (the thread is leased only through it). */
  readonly piExited: (threadId: string, runId: string | undefined, exit: PiExit) => void;
  readonly policyCheck: (
    threadId: string,
    runId: string | undefined,
    check: PolicyChannelCheck,
    reply: (message: PolicyChannelReply) => void,
  ) => void;
  /** kobe-policy stopped waiting for one of its checks (timeout, Stop): free its slot. */
  readonly policyCancel?: (threadId: string, requestId: string) => void;
  /** The thread's policy channel is unusable: every pending check of the thread is denied. */
  readonly policyChannelClosed: (threadId: string, reason: string) => void;
  readonly diagnostic: (threadId: string, message: string) => void;
}

export interface ThreadEnv {
  readonly bin: string;
  /**
   * Parent of the private per-process directories (KOBE-41): each Pi gets a fresh `mkdtemp` dir
   * (0700) holding its `PI_CODING_AGENT_DIR` (Pi 1.0.0 writes `auth.json` there on every
   * credential read) and its model file; removed when the process exits. Nothing in it outlives
   * the process, so nothing a tool writes there reaches another thread or a later Pi.
   */
  readonly runtimeDir: string;
  /** Model gateway wiring; absent when this sandbox has no model access. */
  readonly models?: ModelWiring | undefined;
  /** The kobe-policy extension (root-owned file), loaded last into every Pi (KOBE-36). */
  readonly policyExtension: string;
  /** Other root-owned extension paths loaded with `-e`, before kobe-policy. */
  readonly extensions?: readonly string[];
  /** How long a new Pi may take to report kobe-policy ready (default {@link POLICY_READY_TIMEOUT_MS}). */
  readonly policyReadyTimeoutMs?: number;
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
  #policy: PolicyChannel | undefined;
  #launchKey: string | undefined;
  /** The current Pi's model file (undefined without model wiring). */
  #modelFile: ModelFile | undefined;
  /** Each process's private runtime directory, removed once it has exited. */
  readonly #runtimeDirs = new Map<PiProcess, string>();
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

  /** kobe-policy in the current Pi reported ready and its channel is still open. */
  get policyUsable(): boolean {
    return this.#policy?.ready === true && !this.#policy.closed;
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

  /**
   * Spawn Pi with `launch` (call inside the lock). `model` is the run's model when known at spawn
   * (a `run.start`); a Pi started for a `pi.command` gets none until its first run.
   */
  async spawn(launch: PiLaunch, model: RunModel | null = null): Promise<void> {
    await ensureSessionDir(this.#env.sessionDir);
    await mkdir(this.#env.home, { recursive: true }).catch(() => undefined);
    await mkdir(this.#env.runtimeDir, { recursive: true, mode: 0o700 });
    const runtimeDir = await mkdtemp(path.join(this.#env.runtimeDir, "pi-"));
    let env: Record<string, string>;
    let modelFile: ModelFile | undefined;
    try {
      const agentDir = path.join(runtimeDir, "agent");
      await mkdir(agentDir, { mode: 0o700 });
      env = { ...launch.env, PI_CODING_AGENT_DIR: agentDir };
      const models = this.#env.models;
      if (models !== undefined) {
        modelFile = new ModelFile(path.join(runtimeDir, "model.json"), {
          gatewayUrl: models.gatewayUrl,
          model,
          token: await models.tokens.current(),
          runId: null,
        });
        await modelFile.create();
        env[MODEL_FILE_ENV] = modelFile.path;
      }
    } catch (error) {
      await rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const pi = new PiProcess({
      bin: this.#env.bin,
      args: launch.args,
      cwd: this.#env.workspaceDir,
      env,
      onEvent: (event) => this.#onEvent(pi, event),
      onUiRequest: (request) => this.#onUiRequest(pi, request),
      onExit: (exit) => this.#onExit(pi, exit),
      onDiagnostic: (message) => this.#hooks.diagnostic(this.id, message),
    });
    this.#runtimeDirs.set(pi, runtimeDir);
    const control = pi.control;
    let channel: PolicyChannel | undefined;
    if (control !== undefined) {
      const opened: PolicyChannel = new PolicyChannel(control, {
        onCheck: (check) =>
          this.#hooks.policyCheck(this.id, this.#run?.runId, check, (m) => opened.reply(m)),
        onCancel: (requestId) => this.#hooks.policyCancel?.(this.id, requestId),
        onClosed: (reason) => this.#hooks.policyChannelClosed(this.id, reason),
        onDiagnostic: (message) => this.#hooks.diagnostic(this.id, message),
      });
      channel = opened;
    }
    this.#pi = pi;
    this.#policy = channel;
    this.#launchKey = launch.key;
    this.#modelFile = modelFile;
    this.lastUsed = Date.now();
  }

  /**
   * Make `runId` the run Pi attributes its model calls to (`x-kobe-run-id`), with the run's
   * model, before the prompt is sent. The extension reads the file on Pi's `input` hook and per
   * request. No-op without model wiring.
   */
  async attachRun(runId: string, model: RunModel | null): Promise<void> {
    await this.#modelFile?.update({ runId, model });
  }

  /** A rotated model-gateway token: the next model request uses it (the current one is not cut). */
  async updateToken(token: string): Promise<void> {
    try {
      await this.#modelFile?.update({ token });
    } catch (error) {
      this.#hooks.diagnostic(this.id, `model file not updated: ${(error as Error).message}`);
    }
  }

  /** Where the current Pi's model file is (tests and diagnostics). */
  get modelFilePath(): string | undefined {
    return this.#modelFile?.path;
  }

  /**
   * Wait until kobe-policy in the current Pi reported `channel.ready` (call inside the lock, right
   * after {@link spawn}). No prompt reaches a Pi whose policy extension did not load and self-check:
   * without it Pi would run tools unchecked.
   */
  async waitPolicyReady(): Promise<void> {
    const channel = this.#policy;
    if (channel === undefined) throw new Error("Pi has no policy channel");
    await channel.waitReady(this.#env.policyReadyTimeoutMs ?? POLICY_READY_TIMEOUT_MS);
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
    this.#modelFile
      ?.update({ runId: null })
      .catch((error: unknown) =>
        this.#hooks.diagnostic(this.id, `model file not updated: ${(error as Error).message}`),
      );
    this.#hooks.runEnded(run.runId, this.id);
    run.resolveEnded();
  }

  runEnded(): Promise<void> {
    return this.#run?.ended ?? Promise.resolve();
  }

  /**
   * Stop after the in-flight step: abort on the next `turn_end` (or the run settles first). Never
   * "now": Pi answers `prompt` before it emits `agent_start`, so a stop that arrives in between would
   * otherwise see an idle-looking thread and abort a step that is about to run.
   */
  markStopAfterStep(): void {
    const run = this.#run;
    if (run !== undefined) run.stopAfterStep = true;
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
    const runId = this.#run?.runId;
    if (runId === undefined) {
      // The server leases a thread only through a run: with none active nobody may answer.
      if (DIALOG_METHODS.has(request.method)) this.#cancelDialog(pi, request.id);
      return;
    }
    if (DIALOG_METHODS.has(request.method)) {
      if (this.#dialogs.size >= MAX_PENDING_DIALOGS) {
        pi.send({ type: "extension_ui_response", id: request.id, cancelled: true });
        return;
      }
      this.#dialogs.set(request.id, request);
    }
    this.#hooks.uiRequest(this.id, runId, request);
  }

  /** Cancel open dialogs (their run is no longer leased to this connection). */
  cancelDialogs(): void {
    const pi = this.#pi;
    for (const id of [...this.#dialogs.keys()]) {
      this.#dialogs.delete(id);
      if (pi !== undefined) this.#cancelDialog(pi, id);
    }
  }

  #cancelDialog(pi: PiProcess, id: string): void {
    pi.send({ type: "extension_ui_response", id, cancelled: true });
  }

  #onExit(pi: PiProcess, exit: PiExit): void {
    const expected = this.#closing.delete(pi);
    const runId = pi === this.#pi ? this.#run?.runId : undefined;
    if (pi === this.#pi) this.#detach(pi);
    const runtimeDir = this.#runtimeDirs.get(pi);
    this.#runtimeDirs.delete(pi);
    // The process is gone: so is its private directory (auth.json, model file, token).
    if (runtimeDir !== undefined)
      void rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
    if (!expected) this.#hooks.piExited(this.id, runId, exit);
  }

  #detach(pi: PiProcess): void {
    if (pi !== this.#pi) return;
    this.#pi = undefined;
    this.#policy = undefined;
    this.#launchKey = undefined;
    this.#modelFile = undefined;
    this.#streaming = false;
    this.#dialogs.clear();
    this.endRun();
  }
}
