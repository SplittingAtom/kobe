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
}

export const PI_REQUEST_TIMEOUT_MS = 60_000;
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

  async startRun(frame: RunStartFrame): Promise<CommandOutcome> {
    if (this.#draining) return fail("pi_unavailable", "sandbox is shutting down");
    const thread = this.#thread(frame.thread_id);
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
      await this.#options.beforeRun?.(frame);
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
      if (thread.runId === frame.run_id) thread.endRun();
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
      if (thread.markStopAfterStep()) void this.#abort(thread);
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

  async piCommand(frame: Frame<"pi.command">): Promise<CommandOutcome> {
    const { id: _serverId, ...command } = frame.command;
    if (command.type === "fork") {
      return fail(
        "pi_rejected",
        "fork moves Pi to a new session file; branch with run.start parent_entry_id",
      );
    }
    const thread = this.#thread(frame.thread_id);
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

  async restore(frame: Frame<"session.restore">): Promise<CommandOutcome> {
    const thread = this.#thread(frame.thread_id);
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
      await thread.withLock(() => thread.stopProcess());
      if (!thread.busy && !thread.hasProcess) this.#threads.delete(thread.id);
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
      parentEnv: this.#options.parentEnv,
      config: frame?.config,
    });
    if (thread.hasProcess) {
      const changed = frame?.config !== undefined && launch.key !== thread.launchKey;
      if (!changed || thread.busy) return undefined;
      await thread.stopProcess();
    }
    if (!(await this.#reserveSlot(thread))) {
      return fail("pi_unavailable", "too many threads are active in this sandbox");
    }
    try {
      await thread.spawn(launch);
      return undefined;
    } catch (error) {
      return fail("pi_unavailable", `cannot start Pi: ${(error as Error).message}`);
    }
  }

  /** Make room for one more Pi process by closing the least recently used idle one. */
  async #reserveSlot(thread: Thread): Promise<boolean> {
    const live = [...this.#threads.values()].filter((t) => t.hasProcess && t !== thread);
    if (live.length < this.#options.maxProcesses) return true;
    const idle = live.filter((t) => !t.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (idle === undefined) return false;
    await idle.withLock(() => idle.stopProcess());
    return true;
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
      const response = await thread.request({ type: "abort" }, PI_SLOW_REQUEST_TIMEOUT_MS);
      if (!response.success) throw new Error(response.error);
      if (!thread.streaming) thread.endRun();
      else await raceTimeout(ended, ABORT_SETTLE_GRACE_MS);
      thread.endRun();
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

async function raceTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}
