import { access } from "node:fs/promises";
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
import { SkillError, type SkillStore } from "../skills/store.js";
import {
  AttachmentPathError,
  confineAttachment,
  nativeImages,
  promptWithAttachments,
} from "./attachments.js";
import { fail, ok, type CommandOutcome } from "./outcome.js";
import {
  compactCommand,
  compactFailure,
  compactModelOf,
  compactSuccess,
  compactThrown,
  piCompactFailure,
  selectsModel,
  setModelCommand,
  type CompactReply,
} from "./compact.js";
import { Thread, type ThreadEnv, type ThreadHooks } from "./thread.js";
import type { RunModel } from "../models/types.js";

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
  /**
   * The skills store (KOBE-82). Absent (development, tests): a run that lists skills fails, one
   * that lists none starts as before.
   */
  readonly skills?: Pick<SkillStore, "prepare" | "release">;
  /**
   * The run's current span as a `traceparent` (KOBE-274), written to the model file with the run
   * so Pi's first model call already carries it; absent or null: none.
   */
  readonly traceparentOf?: (runId: string) => string | null;
}

export const PI_REQUEST_TIMEOUT_MS = 60_000;
/** Upper bound for the KOBE-27 `beforeRun` hook (workspace sync) before a run gives up. */
export const BEFORE_RUN_TIMEOUT_MS = 5 * 60_000;
export const PI_SLOW_REQUEST_TIMEOUT_MS = 10 * 60_000;
const ABORT_SETTLE_GRACE_MS = 5000;
/** A run.start that takes longer than this before Pi has its prompt is logged with its stages. */
const SLOW_START_WARN_MS = 5000;
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
  /** run.start commands in progress, by run id (a Stop may arrive before the run begins). */
  readonly #starting = new Map<string, PendingStart>();
  readonly #reaper: NodeJS.Timeout;
  readonly #unsubscribeTokens: (() => void) | undefined;
  readonly #unsubscribeEgress: (() => void) | undefined;
  readonly #unsubscribeMcp: (() => void) | undefined;
  #draining = false;

  constructor(options: ThreadManagerOptions) {
    this.#options = options;
    this.#reaper = setInterval(() => void this.reapIdle(), Math.min(60_000, options.idleMs));
    this.#reaper.unref();
    // A rotated model-gateway token reaches every live Pi's model file (KOBE-41).
    this.#unsubscribeTokens = options.models?.tokens.onChange((token) => {
      for (const thread of this.#threads.values()) void thread.updateToken(token);
    });
    // A rotated mcp-proxy token reaches every live Pi's mcp.json (KOBE-111).
    this.#unsubscribeMcp = options.mcp?.tokens.onChange((token) => {
      for (const thread of this.#threads.values()) void thread.updateMcpToken(token);
    });
    // A rotated egress token reaches every live Pi's egress token file (KOBE-39).
    this.#unsubscribeEgress = options.egress?.tokens.onChange((token) => {
      for (const thread of this.#threads.values()) void thread.updateEgressToken(token);
    });
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
    // Known from the moment it arrives, so a Stop that overtakes it (Pi still starting) is kept.
    const existing = this.#starting.get(frame.run_id);
    const pending = existing ?? { threadId: frame.thread_id, stopped: false };
    if (existing === undefined) this.#starting.set(frame.run_id, pending);
    return this.#claimed(frame.thread_id, (thread) =>
      this.#startRun(thread, frame, pending),
    ).finally(() => {
      if (existing === undefined) this.#starting.delete(frame.run_id);
    });
  }

  async #startRun(
    thread: Thread,
    frame: RunStartFrame,
    pending: PendingStart,
  ): Promise<CommandOutcome> {
    if (this.#draining) return fail("pi_unavailable", "sandbox is shutting down");
    if (thread.runId === frame.run_id) return ok({ already_started: true });
    if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");
    if (thread.restoring) return fail("pi_rejected", "session restore in progress");
    const attachmentError = await this.#checkAttachments(frame);
    if (attachmentError !== undefined) return fail("pi_rejected", attachmentError);
    const model = runModelOf(frame);
    if (this.#options.models !== undefined && model === null) {
      // The server found no model for the run (no team default): say so before any Pi work.
      return fail("model_not_configured", "no model is enabled for this team");
    }

    if (pending.stopped) return this.#stoppedBeforePrompt(thread, frame);
    const prepared = await thread.withLock(() => this.#prepareRun(thread, frame));
    if (prepared !== undefined) return prepared;
    if (pending.stopped) return this.#stoppedBeforePrompt(thread, frame);
    if (thread.runId !== undefined) return fail("pi_rejected", "thread has an active run");

    thread.beginRun(frame.run_id);
    thread.setPreparing(true);
    // Until the prompt goes out a Stop ends the run at once (#abort: Pi has none of it), and
    // another run may then hold the thread: this start ends only its own run from here on.
    const own = () => thread.runId === frame.run_id;
    const endOwn = () => {
      if (own()) thread.endRun();
    };
    const began = Date.now();
    const stages: string[] = [];
    const mark = (stage: string) => stages.push(`${stage} ${Date.now() - began} ms`);
    try {
      // The tripwire first (before the run's own write to the model file would hide a rewrite).
      const tampered = await thread.verifyRuntime();
      if (tampered !== undefined) {
        await thread.withLock(() => thread.stopProcess());
        endOwn();
        return fail("runtime_tampered", tampered);
      }
      try {
        await thread.attachRun(
          frame.run_id,
          model,
          frame.run_token?.token,
          this.#options.traceparentOf?.(frame.run_id) ?? null,
        );
        // The run's memory (KOBE-157): its own file, so a changed index never restarts Pi.
        // Project instructions (KOBE-245) only for an agent that announced `projects`.
        await thread.attachMemory(
          frame.memory,
          this.#options.projectTools ? frame.project : undefined,
        );
      } catch (error) {
        endOwn();
        return fail("pi_unavailable", `model file not written: ${(error as Error).message}`);
      }
      // And once more with the run's file in place: the prompt goes out right after this.
      const tamperedAfter = await thread.verifyRuntime();
      if (tamperedAfter !== undefined) {
        await thread.withLock(() => thread.stopProcess());
        endOwn();
        return fail("runtime_tampered", tamperedAfter);
      }
      mark("attached");
      if (this.#options.beforeRun !== undefined) {
        const timedOut = await withTimeout(
          this.#options.beforeRun(frame),
          this.#options.beforeRunTimeoutMs ?? BEFORE_RUN_TIMEOUT_MS,
        );
        if (timedOut) {
          this.#warn(thread.id, `run ${frame.run_id}: workspace preparation timed out`);
          endOwn();
          return fail("internal", "workspace preparation timed out");
        }
      }
      mark("workspace ready");
      // The files are in place now: confine them again (the model can write symlinks into the
      // workspace) and read the images Pi gets inline.
      const media = await this.#promptMedia(frame);
      if (typeof media === "string") {
        endOwn();
        return fail("pi_rejected", media);
      }
      if (!own()) return this.#stoppedBeforePrompt(thread, frame);
      // From here on Pi has the run: a Stop aborts it in Pi (#abort).
      thread.setPreparing(false);
      const response = await thread.request(
        {
          type: "prompt",
          message: promptWithAttachments(frame.message, frame.attachments ?? [], media.inlined),
          ...(media.images.length > 0 ? { images: media.images } : {}),
          ...(thread.streaming ? { streamingBehavior: "followUp" } : {}),
        },
        PI_REQUEST_TIMEOUT_MS,
      );
      if (!response.success) {
        endOwn();
        return fail("pi_rejected", response.error);
      }
      mark("prompt taken");
      // A start this slow is what a Stop or a second message meets as a busy thread: say where.
      if (Date.now() - began > SLOW_START_WARN_MS) {
        this.#warn(thread.id, `run ${frame.run_id} started slowly: ${stages.join(", ")}`);
      }
      const disposition = dispositionOf(response.data);
      if (disposition === "handled") endOwn();
      return ok({ disposition });
    } catch (error) {
      // Pi may still act on the prompt: stop it rather than leave it working without a run.
      if (own()) await thread.withLock(() => thread.stopProcess());
      endOwn();
      return piFailure(error);
    }
  }

  async steerRun(frame: Frame<"run.steer">): Promise<CommandOutcome> {
    const thread = this.#threads.get(frame.thread_id);
    if (thread?.runId !== frame.run_id) return fail("unknown_run", "run is not active here");
    // A compaction has no turn to steer (Pi would queue the message for after it).
    if (thread.compacting) return fail("pi_rejected", "the thread is compacting");
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
    if (thread?.runId !== frame.run_id) {
      // Its run.start is still starting Pi: the start sees this and never begins the run.
      const pending = this.#starting.get(frame.run_id);
      if (pending?.threadId !== frame.thread_id) {
        return fail("unknown_run", "run is not active here");
      }
      pending.stopped = true;
      return ok({ stopped: true });
    }
    const ended = thread.runEnded();
    // A compaction has no step to finish (no turn_end ever comes): after_step aborts it too; nor
    // has a run whose prompt Pi does not have yet.
    if (frame.mode === "after_step" && !thread.compacting && !thread.runPreparing) {
      thread.onStopDue = () => void this.#abort(thread);
      thread.markStopAfterStep();
    } else {
      void this.#abort(thread);
    }
    await ended;
    return ok({ stopped: true });
  }

  /** Abort a run the server no longer leases to us, or one the outbox gave up on. */
  /** The run's current span for its model calls (KOBE-274). */
  setTraceparent(runId: string, traceparent: string | null): void {
    for (const thread of this.#threads.values()) thread.setTraceparent(runId, traceparent);
  }

  abortRun(runId: string): void {
    for (const thread of this.#threads.values()) {
      if (thread.runId === runId) void this.#abort(thread);
    }
  }

  /**
   * `thread.compact` (KOBE-213): Pi's `compact` as the compaction run. Refused while the thread has
   * any other run (Pi's compact would abort it), checked again under the thread lock; the thread is
   * busy until Pi answers. The run's model is selected before `compact` (Pi reads it first), its
   * token is held in memory and handed to kobe-models on request, and the run ends with the answer.
   */
  compact(frame: Frame<"thread.compact">): Promise<CompactReply> {
    return this.#claimed(frame.thread_id, (thread) => this.#compact(thread, frame));
  }

  async #compact(thread: Thread, frame: Frame<"thread.compact">): Promise<CompactReply> {
    if (this.#draining) return compactFailure("pi_unavailable", "sandbox is shutting down");
    if (this.#options.models === undefined) {
      return compactFailure("model_not_configured", "this sandbox has no model gateway access");
    }
    // The thread is the compaction's from the busy check on (under the lock): a run.start that
    // arrives meanwhile is refused, so it never runs with the model selected below.
    const busy =
      busyFor(thread) ??
      (await thread.withLock(async () => {
        const held = busyFor(thread);
        if (held === undefined) thread.beginRun(frame.run_id, true);
        return held;
      }));
    if (busy !== undefined) return busy;
    const model = compactModelOf(frame);
    try {
      const ready = await this.#compactReady(thread, model);
      if (ready !== undefined) return ready;
      // Memory only (KOBE-118): kobe-models asks for it when Pi starts summarizing.
      await thread.attachRun(
        frame.run_id,
        model,
        frame.run_token.token,
        this.#options.traceparentOf?.(frame.run_id) ?? null,
      );
      // Once more with the run's file in place: `compact` goes out right after this.
      const tampered = await thread.verifyRuntime();
      if (tampered !== undefined) {
        await thread.stopTampered(tampered, "compact");
        return compactFailure("runtime_tampered", tampered);
      }
      const response = await thread.request(compactCommand(frame), PI_SLOW_REQUEST_TIMEOUT_MS);
      return response.success ? compactSuccess(response.data) : piCompactFailure(response.error);
    } catch (error) {
      // Pi may still be summarizing: stop it rather than leave it working without a run.
      if (thread.runId === frame.run_id) await thread.withLock(() => thread.stopProcess());
      return compactThrown(error);
    } finally {
      if (thread.runId === frame.run_id) thread.endRun();
    }
  }

  /**
   * With the compaction's run begun: a Pi whose selected model is the compaction's. A running Pi
   * is switched with `set_model` (only after the tripwire found its config as the agent wrote it,
   * KOBE-169); one that does not know the model (registered for another run) is restarted once
   * with it in its model file, keeping the run. Undefined when ready.
   */
  async #compactReady(thread: Thread, model: RunModel): Promise<CompactReply | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = await thread.withLock(async () => {
        if (attempt > 0) await thread.stopProcess({ keepRun: true });
        const failed = await this.#ensureProcess(thread, undefined, model);
        return failed === undefined || failed.ok
          ? undefined
          : compactFailure(compactCode(failed.code), failed.message);
      });
      if (started !== undefined) return started;
      const tampered = await thread.verifyRuntime();
      if (tampered !== undefined) {
        await thread.stopTampered(tampered, "compact");
        return compactFailure("runtime_tampered", tampered);
      }
      if (await this.#selectModel(thread, model)) return undefined;
    }
    return compactFailure("model_not_configured", "Pi did not select the compaction's model");
  }

  async #selectModel(thread: Thread, model: RunModel): Promise<boolean> {
    const gatewayUrl = this.#options.models?.gatewayUrl;
    if (gatewayUrl === undefined) return false;
    const selected = async () => {
      const state = await thread.request({ type: "get_state" }, PI_REQUEST_TIMEOUT_MS);
      return state.success && selectsModel(state.data, model, gatewayUrl);
    };
    if (await selected()) return true;
    const set = await thread.request(setModelCommand(model), PI_REQUEST_TIMEOUT_MS);
    return set.success && (await selected());
  }

  piCommand(frame: Frame<"pi.command">): Promise<CommandOutcome> {
    return this.#claimed(frame.thread_id, (thread) => this.#piCommand(thread, frame));
  }

  async #piCommand(thread: Thread, frame: Frame<"pi.command">): Promise<CommandOutcome> {
    const { id: _serverId, ...command } = frame.command;
    if (thread.restoring) return fail("pi_rejected", "session restore in progress");
    // Nothing reaches Pi around a compaction in progress (KOBE-213); its entry is read after it.
    if (thread.compacting) return fail("pi_rejected", "the thread is compacting");
    if (
      command.type === "get_entries" &&
      command.since === undefined &&
      !(await fileExists(this.#sessionFile(thread.id)))
    ) {
      // KOBE-258: Pi 1.0.0 keeps a new session's setup entries (model, thinking level) in memory
      // until the first user message. Reported, they would be mirrored, and the thread's next Pi
      // (restarted for a run's config) makes new ones with other ids: `get_entries since` then
      // fails for good. Before the file exists nothing is durable, so nothing is reported.
      return ok({ entries: [], leafId: null });
    }
    const prepared = await thread.withLock(() => this.#ensureProcess(thread, undefined));
    if (prepared !== undefined) return prepared;
    // KOBE-169: no pi.command runs against config a tool planted (the plant could be gone again by
    // the next prompt, so check before and after). The allow-list has no command that selects a
    // model from Pi's catalog (set_model is gone; model choice is run.start's), this is the second line.
    {
      const before = await thread.verifyRuntime();
      if (before !== undefined) {
        await thread.stopTampered(before, command.type);
        return fail("runtime_tampered", before);
      }
    }
    try {
      const timeout = SLOW_COMMANDS.has(command.type)
        ? PI_SLOW_REQUEST_TIMEOUT_MS
        : PI_REQUEST_TIMEOUT_MS;
      const response = await thread.request(command, timeout);
      const after = await thread.verifyRuntime();
      if (after !== undefined) {
        await thread.stopTampered(after, command.type);
        return fail("runtime_tampered", after);
      }
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
        await ensureSessionDir(this.#options.sessionDir, {
          shared: this.#options.identities !== undefined,
          workspaceDir: this.#options.workspaceDir,
        });
        await this.#restores.get(thread.id)?.abort();
        this.#restores.set(
          thread.id,
          new SessionRestore(
            this.#sessionFile(thread.id),
            this.#options.restoreMaxBytes,
            this.#options.workspaceDir,
          ),
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
    this.#unsubscribeTokens?.();
    this.#unsubscribeEgress?.();
    this.#unsubscribeMcp?.();
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
        this.#options.skills?.release(thread.id);
        if (!thread.busy && this.#threads.get(thread.id) === thread) {
          this.#threads.delete(thread.id);
        }
      });
    }
  }

  /** Run a command with the thread claimed (busy) from arrival to answer. */
  async #claimed<T>(threadId: string, fn: (thread: Thread) => Promise<T>): Promise<T> {
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
        new Date(),
        this.#options.workspaceDir,
      );
      if (!branch.ok) return fail("pi_rejected", branch.message);
    }
    return this.#ensureProcess(thread, frame);
  }

  /** Spawn (or restart, when the run's config changed) the thread's Pi. Inside the lock. */
  async #ensureProcess(
    thread: Thread,
    frame: RunStartFrame | undefined,
    model: RunModel | null = runModelOf(frame),
  ): Promise<CommandOutcome | undefined> {
    let skillDirs: readonly string[] = [];
    if (frame !== undefined) {
      const refs = frame.config?.skill_bundles ?? [];
      // The skills come before the process: Pi is started with exactly the run's effective skills,
      // and a store that fails (hash mismatch, unsafe bundle) fails the run instead of starting
      // Pi with skills nobody vouched for.
      if (this.#options.skills === undefined && refs.length > 0)
        return fail("pi_unavailable", "skills: this sandbox cannot materialize skills");
      const unlisted = (frame.config?.skills ?? []).filter((n) => !refs.some((r) => r.name === n));
      if (unlisted.length > 0)
        return fail("pi_rejected", `skills: no bundle for ${unlisted.join(", ")}`);
      try {
        skillDirs = (await this.#options.skills?.prepare(thread.id, refs)) ?? [];
      } catch (error) {
        const message = error instanceof SkillError ? error.message : (error as Error).message;
        return fail("pi_unavailable", `skills: ${message}`);
      }
    }
    // Connector tools need the proxy wiring: a run that lists connectors never starts without them.
    if ((frame?.mcp?.servers.length ?? 0) > 0 && this.#options.mcp === undefined)
      return fail("pi_unavailable", "mcp: this sandbox has no MCP proxy access");
    const launch = buildPiLaunch({
      sessionFile: this.#sessionFile(thread.id),
      skillDirs,
      home: this.#options.home,
      modelsExtension: this.#options.models?.extension,
      policyExtension: this.#options.policyExtension,
      toolsExtension: this.#options.toolsExtension,
      execExtension: this.#options.exec === undefined ? undefined : this.#options.execExtension,
      toolsFiles: this.#options.shareFiles,
      toolsProjects: this.#options.projectTools,
      toolsMemory: this.#options.memoryTools,
      ...(this.#options.extensions === undefined ? {} : { extensions: this.#options.extensions }),
      parentEnv: this.#options.parentEnv,
      config: frame?.config,
      mcp: frame?.mcp,
      model,
    });
    if (thread.hasProcess) {
      // `mcp` can arrive without `config` (an agent that lost all its connectors): still a change.
      const changed =
        (frame?.config !== undefined || frame?.mcp !== undefined) &&
        launch.key !== thread.launchKey;
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
      await thread.spawn(launch, model);
    } catch (error) {
      return fail("pi_unavailable", `cannot start Pi: ${(error as Error).message}`);
    } finally {
      // From here on the process counts through `thread.hasProcess`.
      this.#pendingSpawns -= 1;
    }
    try {
      await thread.waitPolicyReady();
    } catch (error) {
      // Fail closed: a Pi whose kobe-policy did not load would run tools unchecked.
      await thread.stopProcess();
      return fail("pi_unavailable", `kobe-policy did not start: ${(error as Error).message}`);
    }
    const tampered = await thread.verifyRuntime();
    if (tampered !== undefined) {
      await thread.stopProcess();
      return fail("runtime_tampered", tampered);
    }
    return undefined;
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
          if (idle.busy) return; // claimed meanwhile: leave it
          await idle.stopProcess();
          this.#options.skills?.release(idle.id);
        });
      } finally {
        this.#evicting.delete(idle);
      }
    }
  }

  async #checkAttachments(frame: RunStartFrame): Promise<string | undefined> {
    try {
      for (const attachment of frame.attachments ?? []) {
        await confineAttachment(this.#options.workspaceDir, attachment.path);
      }
      return undefined;
    } catch (error) {
      if (error instanceof AttachmentPathError) return error.message;
      throw error;
    }
  }

  /** The images for the prompt, or the refusal text when an attachment is not confined. */
  async #promptMedia(
    frame: RunStartFrame,
  ): Promise<Awaited<ReturnType<typeof nativeImages>> | string> {
    try {
      await this.#checkAttachments(frame).then((refusal) => {
        if (refusal !== undefined) throw new AttachmentPathError(refusal);
      });
      return await nativeImages(this.#options.workspaceDir, frame.attachments ?? []);
    } catch (error) {
      if (error instanceof AttachmentPathError) return error.message;
      throw error;
    }
  }

  /** Stop: drop Pi's steering/follow-up queue first (else abort continues it), then abort. */
  async #abort(thread: Thread): Promise<void> {
    if (!thread.beginStopping()) return;
    // Its prompt has not gone to Pi: end it now; its start sees that and never sends it.
    if (thread.runPreparing) {
      thread.endRun();
      return;
    }
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
    } catch (error) {
      // Pi did not abort cleanly: stop the process (ends the run; tools in its group die too).
      this.#warn(thread.id, `stopping Pi: ${(error as Error).message}`);
      await thread.withLock(() => thread.stopProcess());
    }
  }

  #stoppedBeforePrompt(thread: Thread, frame: RunStartFrame): CommandOutcome {
    this.#warn(thread.id, `run ${frame.run_id} was stopped before Pi took its prompt`);
    return stoppedBeforePrompt;
  }

  #warn(threadId: string, message: string): void {
    const hooks = this.#options.hooks;
    (hooks.warning ?? hooks.diagnostic)(threadId, message);
  }
}

/** A run.start in progress; `stopped` once a Stop for its run arrived before the run began. */
interface PendingStart {
  readonly threadId: string;
  stopped: boolean;
}

/** A run.start whose run was stopped before its prompt went to Pi (the server ended it already). */
const stoppedBeforePrompt = fail("run_not_active", "the run was stopped before Pi took its prompt");

/** The run's gateway model from `run.start.config` (both fields, else no model) and its limits. */
function runModelOf(frame: RunStartFrame | undefined): RunModel | null {
  const model = frame?.config?.model;
  const limits = frame?.config?.model_limits;
  if (model?.gateway_model === undefined || model.api === undefined) return null;
  return {
    gatewayModel: model.gateway_model,
    api: model.api,
    ...(limits === undefined
      ? {}
      : {
          limits: {
            maxOutputTokens: limits.max_output_tokens,
            contextWindow: limits.context_window,
          },
        }),
  };
}

/** A compaction is refused while the thread runs, streams or restores (the server's lock is first). */
function busyFor(thread: Thread): CompactReply | undefined {
  if (thread.runId !== undefined || thread.streaming) {
    return compactFailure("thread_busy", "thread has an active run");
  }
  if (thread.restoring) return compactFailure("thread_busy", "session restore in progress");
  return undefined;
}

/** A failed Pi start as a `thread.compact_result` code. */
function compactCode(code: string): "pi_unavailable" | "internal" {
  return code === "pi_unavailable" ? "pi_unavailable" : "internal";
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

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
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
