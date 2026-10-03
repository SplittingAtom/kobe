import path from "node:path";
import type {
  PiExtensionUiRequest,
  PiSessionHeader,
  RunStartFrame,
  RunStopFrame,
  ServerToSandboxFrame,
} from "@kobe/protocol";
import { PiProcessError } from "../pi/pi-process.js";
import { buildPiLaunch } from "../pi/pi-launch.js";
import {
  SessionRestore,
  appendBranchMarker,
  ensureSessionDir,
  sessionFilePath,
} from "../pi/session-files.js";
import { fail, ok, type CommandOutcome } from "./outcome.js";
import { Thread, type ThreadEnv, type ThreadHooks } from "./thread.js";

type Frame<T extends ServerToSandboxFrame["type"]> = Extract<ServerToSandboxFrame, { type: T }>;

export interface ThreadManagerOptions extends ThreadEnv {
  readonly hooks: ThreadHooks;
  readonly maxProcesses: number;
  readonly idleMs: number;
  readonly restoreMaxBytes: number;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** Seam for KOBE-27 (S3 ↔ /workspace sync): runs before a prompt reaches Pi. */
  readonly beforeRun?: (frame: RunStartFrame) => Promise<void>;
  readonly beforeRunTimeoutMs?: number;
}

export const PI_REQUEST_TIMEOUT_MS = 60_000;
/** Upper bound for the KOBE-27 `beforeRun` hook (workspace sync) before a run gives up. */
export const BEFORE_RUN_TIMEOUT_MS = 5 * 60_000;
export const PI_SLOW_REQUEST_TIMEOUT_MS = 10 * 60_000;
const ABORT_SETTLE_GRACE_MS = 5000;
const SLOW_COMMANDS = new Set(["compact", "abort"]);

/**
 * Supervises one `pi --mode rpc` process per active thread (D13), all sharing /workspace, and maps
 * server commands onto Pi RPC: run.start → prompt, run.steer → steer, run.stop → clear_queue +
 * abort, pi.command → the allow-listed command, session.restore → the thread's session file.
 */
export class ThreadManager {
  readonly #options: ThreadManagerOptions;
  readonly #threads = new Map<string, Thread>();
  readonly #restores = new Map<string, SessionRestore>();
  #pendingSpawns = 0;
  readonly #evicting = new Set<Thread>();
  readonly #reaper: NodeJS.Timeout;
  #draining = false;

  constructor(options: ThreadManagerOptions) {
    this.#options = options;
    this.#reaper = setInterval(() => void this.reapIdle(), Math.min(60_000, options.idleMs));
    this.#reaper.unref();
  }

  get draining(): boolean {
    return this.#draining;
  }

  activeRuns(): { runId: string; threadId: string }[] {
    return [...this.#threads.values()].flatMap((t) =>
      t.runId === undefined ? [] : [{ runId: t.runId, threadId: t.id }],
    );
  }

  pendingDialogs(): {
    threadId: string;
    runId: string | undefined;
    request: PiExtensionUiRequest;
  }[] {
    return [...this.#threads.values()].flatMap((t) =>
      t.pendingDialogs.map((request) => ({ threadId: t.id, runId: t.runId, request })),
    );
  }

  startRun(frame: RunStartFrame): Promise<CommandOutcome> {
    return this.#claimed(frame.thread_id, (thread) => this.#startRun(thread, frame));
  }

  async #startRun(thread: Thread, frame: RunStartFrame): Promise<CommandOutcome> {
    if (this.#draining) return fail("pi_unavailable", "sandbox is shutting down");
    if (thread.runId === frame.run_id) return ok({ already_started: true });
    if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");
    if (thread.restoring) return fail("pi_rejected", "session restore in progress");
    const attachmentError = this.#checkAttachments(frame);
    if (attachmentError !== undefined) return fail("pi_rejected", attachmentError);

    const prepared = await thread.withLock(() => this.#prepareRun(thread, frame));
    if (prepared !== undefined) return prepared;
    if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");

    thread.beginRun(frame.run_id);
    try {
      if (this.#options.beforeRun !== undefined) {
        const timedOut = await withTimeout(
          this.#options.beforeRun(frame),
          this.#options.beforeRunTimeoutMs ?? BEFORE_RUN_TIMEOUT_MS,
        );
        if (timedOut) {
          thread.endRun();
          return fail("internal", "workspace preparation timed out");
        }
      }
      const response = await thread.request(
        {
          type: "prompt",
          message: promptText(frame),
          ...(thread.streaming ? { streamingBehavior: "followUp" } : {}),
        },
        PI_REQUEST_TIMEOUT_MS,
      );
      if (!response.success) {
        thread.endRun();
        return fail("pi_rejected", response.error);
      }
      const disposition = dispositionOf(response.data);
      if (disposition === "handled") thread.endRun();
      return ok({ disposition });
    } catch (error) {
      // Pi may still act on the prompt: stop it rather than leave it working without a run.
      if (thread.runId === frame.run_id) await thread.withLock(() => thread.stopProcess());
      thread.endRun();
      return piFailure(error);
    }
  }

  async steerRun(frame: Frame<"run.steer">): Promise<CommandOutcome> {
    const thread = this.#threads.get(frame.thread_id);
    if (thread?.runId !== frame.run_id) return fail("unknown_run", "run is not active here");
    try {
      const response = await thread.request(
        { type: "steer", message: frame.message },
        PI_REQUEST_TIMEOUT_MS,
      );
      return response.success
        ? ok({ disposition: dispositionOf(response.data) })
        : fail("pi_rejected", response.error);
    } catch (error) {
      return piFailure(error);
    }
  }

  async stopRun(frame: RunStopFrame): Promise<CommandOutcome> {
    const thread = this.#threads.get(frame.thread_id);
    if (thread?.runId !== frame.run_id) return fail("unknown_run", "run is not active here");
    const ended = thread.runEnded();
    if (frame.mode === "after_step") {
      thread.onStopDue = () => void this.#abort(thread);
      thread.markStopAfterStep();
    } else {
      void this.#abort(thread);
    }
    await ended;
    return ok({ stopped: true });
  }

  /** Abort a run the server no longer leases to us, or one the outbox gave up on. */
  abortRun(runId: string): void {
    for (const thread of this.#threads.values()) {
      if (thread.runId === runId) void this.#abort(thread);
    }
  }

  piCommand(frame: Frame<"pi.command">): Promise<CommandOutcome> {
    return this.#claimed(frame.thread_id, (thread) => this.#piCommand(thread, frame));
  }

  async #piCommand(thread: Thread, frame: Frame<"pi.command">): Promise<CommandOutcome> {
    const { id: _serverId, ...command } = frame.command;
    if (thread.restoring) return fail("pi_rejected", "session restore in progress");
    const prepared = await thread.withLock(() => this.#ensureProcess(thread, undefined));
    if (prepared !== undefined) return prepared;
    try {
      const timeout = SLOW_COMMANDS.has(command.type)
        ? PI_SLOW_REQUEST_TIMEOUT_MS
        : PI_REQUEST_TIMEOUT_MS;
      const response = await thread.request(command, timeout);
      return response.success ? ok(response.data) : fail("pi_rejected", response.error);
    } catch (error) {
      return piFailure(error);
    }
  }

  restore(frame: Frame<"session.restore">): Promise<CommandOutcome> {
    return this.#claimed(frame.thread_id, (thread) => this.#restore(thread, frame));
  }

  async #restore(thread: Thread, frame: Frame<"session.restore">): Promise<CommandOutcome> {
    if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");
    return thread.withLock(async () => {
      if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");
      if (frame.part === 0) {
        await thread.stopProcess();
        await ensureSessionDir(this.#options.sessionDir);
        await this.#restores.get(thread.id)?.abort();
        this.#restores.set(
          thread.id,
          new SessionRestore(this.#sessionFile(thread.id), this.#options.restoreMaxBytes),
        );
        thread.restoring = true;
      }
      const restore = this.#restores.get(thread.id);
      if (restore === undefined)
        return fail("pi_rejected", "no restore in progress (part 0 first)");
      try {
        // Pi refuses a session whose stored cwd does not exist (verified 1.0.0): the restored
        // session belongs to this sandbox's workspace, whatever the server's copy says.
        const header =
          frame.header === undefined
            ? undefined
            : { ...frame.header, cwd: this.#options.workspaceDir };
        const entries = await restore.writePart(frame.part, header, frame.entries, () =>
          this.#defaultHeader(thread.id),
        );
        if (!frame.final) return ok({ part: frame.part, entries });
        const total = await restore.commit();
        this.#endRestore(thread);
        return ok({ restored: true, entries: total });
      } catch (error) {
        await restore.abort();
        this.#endRestore(thread);
        return fail("internal", `session restore failed: ${(error as Error).message}`);
      }
    });
  }

  /** Connection lost: partial restores are void (the server restarts from part 0). */
  async abortRestores(): Promise<void> {
    await Promise.all(
      [...this.#restores.entries()].map(async ([threadId, restore]) => {
        const thread = this.#threads.get(threadId);
        if (thread === undefined) return;
        await thread.withLock(async () => {
          if (this.#restores.get(threadId) !== restore) return;
          await restore.abort();
          this.#endRestore(thread);
        });
      }),
    );
  }

  /** After a reconnect: cancel open dialogs of threads whose runs the server did not list. */
  cancelDialogsExcept(leasedRuns: ReadonlySet<string>): void {
    for (const thread of this.#threads.values()) {
      const runId = thread.runId;
      if (runId === undefined || !leasedRuns.has(runId)) thread.cancelDialogs();
    }
  }

  uiResponse(frame: Frame<"pi.ui_response">): boolean {
    return this.#threads.get(frame.thread_id)?.answerDialog(frame.response) ?? false;
  }

  /** Stop accepting runs; wait for active ones up to the deadline, then abort and close all. */
  async shutdown(deadlineMs: number): Promise<void> {
    this.#draining = true;
    clearInterval(this.#reaper);
    const active = [...this.#threads.values()].map((t) => t.runEnded());
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(active),
      new Promise((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      }),
    ]);
    clearTimeout(timer);
    await Promise.all(
      [...this.#threads.values()].map(async (thread) => {
        if (thread.runId !== undefined) await this.#abort(thread);
        await thread.withLock(() => thread.stopProcess());
      }),
    );
  }

  killAll(): void {
    for (const thread of this.#threads.values()) thread.kill();
  }

  /** Close Pi processes of threads idle longer than `idleMs`; forget empty threads. */
  async reapIdle(now = Date.now()): Promise<void> {
    for (const thread of [...this.#threads.values()]) {
      if (thread.busy || now - thread.lastUsed < this.#options.idleMs) continue;
      await thread.withLock(async () => {
        // Re-checked under the lock: a command may have claimed the thread meanwhile.
        if (thread.busy || Date.now() - thread.lastUsed < this.#options.idleMs) return;
        await thread.stopProcess();
        if (!thread.busy && this.#threads.get(thread.id) === thread) {
          this.#threads.delete(thread.id);
        }
      });
    }
  }

  /** Run a command with the thread claimed (busy) from arrival to answer. */
  async #claimed(
    threadId: string,
    fn: (thread: Thread) => Promise<CommandOutcome>,
  ): Promise<CommandOutcome> {
    const thread = this.#thread(threadId);
    const release = thread.claim();
    try {
      return await fn(thread);
    } finally {
      release();
    }
  }

  #endRestore(thread: Thread): void {
    this.#restores.delete(thread.id);
    thread.restoring = false;
  }

  #thread(threadId: string): Thread {
    let thread = this.#threads.get(threadId);
    if (thread === undefined) {
      thread = new Thread(threadId, this.#options, this.#options.hooks);
      this.#threads.set(threadId, thread);
    }
    return thread;
  }

  #sessionFile(threadId: string): string {
    return sessionFilePath(this.#options.sessionDir, threadId);
  }

  #defaultHeader(threadId: string): PiSessionHeader {
    return {
      type: "session",
      version: 3,
      id: threadId,
      timestamp: new Date().toISOString(),
      cwd: this.#options.workspaceDir,
    };
  }

  async #prepareRun(thread: Thread, frame: RunStartFrame): Promise<CommandOutcome | undefined> {
    // Re-checked under the lock: a concurrent run.start may have won the thread meanwhile.
    if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");
    if (thread.restoring) return fail("pi_rejected", "session restore in progress");
    if (frame.parent_entry_id !== undefined) {
      await thread.stopProcess();
      const branch = await appendBranchMarker(
        this.#sessionFile(thread.id),
        frame.parent_entry_id,
        frame.run_id,
      );
      if (!branch.ok) return fail("pi_rejected", branch.message);
    }
    return this.#ensureProcess(thread, frame);
  }

  /** Spawn (or restart, when the run's config changed) the thread's Pi. Inside the lock. */
  async #ensureProcess(
    thread: Thread,
    frame: RunStartFrame | undefined,
  ): Promise<CommandOutcome | undefined> {
    const launch = buildPiLaunch({
      sessionFile: this.#sessionFile(thread.id),
      home: this.#options.home,
      agentDir: this.#options.agentDir,
      policyExtension: this.#options.policyExtension,
      ...(this.#options.extensions === undefined ? {} : { extensions: this.#options.extensions }),
      parentEnv: this.#options.parentEnv,
      config: frame?.config,
    });
    if (thread.hasProcess) {
      const changed = frame?.config !== undefined && launch.key !== thread.launchKey;
      // A Pi whose policy channel closed blocks every tool call for good: start a fresh one (not
      // while it is busy — its calls are blocked anyway, and Stop must still reach it).
      const broken = !thread.policyUsable;
      if (!changed && !broken) return undefined;
      if (thread.runId !== undefined || thread.streaming) return undefined;
      await thread.stopProcess();
    }
    if (!(await this.#reserveSlot(thread))) {
      return fail("pi_unavailable", "too many threads are active in this sandbox");
    }
    try {
      await thread.spawn(launch);
    } catch (error) {
      return fail("pi_unavailable", `cannot start Pi: ${(error as Error).message}`);
    } finally {
      // From here on the process counts through `thread.hasProcess`.
      this.#pendingSpawns -= 1;
    }
    try {
      await thread.waitPolicyReady();
      return undefined;
    } catch (error) {
      // Fail closed: a Pi whose kobe-policy did not load would run tools unchecked.
      await thread.stopProcess();
      return fail("pi_unavailable", `kobe-policy did not start: ${(error as Error).message}`);
    }
  }

  /**
   * Reserve a process slot (counted synchronously with spawns in flight, so concurrent spawns cannot
   * overshoot the cap), closing least recently used idle Pi processes to make room. The caller
   * releases the reservation (`#pendingSpawns`) once its spawn finished. No global lock is held
   * while waiting for another thread's lock, so this cannot deadlock.
   */
  async #reserveSlot(thread: Thread): Promise<boolean> {
    for (;;) {
      const others = [...this.#threads.values()].filter((t) => t !== thread);
      const live = others.filter((t) => t.hasProcess).length + this.#pendingSpawns;
      if (live < this.#options.maxProcesses) {
        this.#pendingSpawns += 1;
        return true;
      }
      const idle = others
        .filter((t) => t.hasProcess && !t.busy && !this.#evicting.has(t))
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle === undefined) return false;
      this.#evicting.add(idle);
      try {
        await idle.withLock(async () => {
          if (!idle.busy) await idle.stopProcess(); // claimed meanwhile: leave it
        });
      } finally {
        this.#evicting.delete(idle);
      }
    }
  }

  #checkAttachments(frame: RunStartFrame): string | undefined {
    const root = path.resolve(this.#options.workspaceDir);
    for (const attachment of frame.attachments ?? []) {
      const resolved = path.resolve(root, attachment.path);
      if (!resolved.startsWith(`${root}${path.sep}`)) return "attachment outside the workspace";
    }
    return undefined;
  }

  /** Stop: drop Pi's steering/follow-up queue first (else abort continues it), then abort. */
  async #abort(thread: Thread): Promise<void> {
    if (!thread.beginStopping()) return;
    const ended = thread.runEnded();
    try {
      await thread.request({ type: "clear_queue" }, PI_REQUEST_TIMEOUT_MS).catch(() => undefined);
      // A run whose prompt was accepted settles even if Pi had not emitted agent_start yet when the
      // abort arrived; never end it early, or Pi would keep working with no run to report to.
      for (let attempt = 0; attempt < 2 && thread.runId !== undefined; attempt++) {
        const response = await thread.request({ type: "abort" }, PI_SLOW_REQUEST_TIMEOUT_MS);
        if (!response.success) throw new Error(response.error);
        await raceTimeout(ended, ABORT_SETTLE_GRACE_MS);
      }
      if (thread.runId !== undefined) throw new Error("run did not settle after abort");
    } catch {
      // Pi did not abort cleanly: stop the process (ends the run; tools in its group die too).
      await thread.withLock(() => thread.stopProcess());
    }
  }
}

function promptText(frame: RunStartFrame): string {
  const attachments = frame.attachments ?? [];
  if (attachments.length === 0) return frame.message;
  const list = attachments.map((a) => `- ${a.path} (${a.mime_type})`).join("\n");
  return `${frame.message}\n\nAttached files:\n${list}`;
}

function dispositionOf(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const value = (data as { disposition?: unknown }).disposition;
  return typeof value === "string" ? value : undefined;
}

function piFailure(error: unknown): CommandOutcome {
  if (error instanceof PiProcessError) return fail("pi_unavailable", error.message);
  return fail("internal", "unexpected error talking to Pi");
}

/** Resolves true when `promise` did not settle within `ms` (its rejection propagates). */
async function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<true>((resolve) => (timer = setTimeout(() => resolve(true), ms)));
  try {
    return await Promise.race([promise.then(() => false as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function raceTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}
