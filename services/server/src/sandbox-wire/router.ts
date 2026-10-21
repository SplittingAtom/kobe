import { sql, withTeam, type KobeDb, type SandboxCommandKind } from "@kobe/db";
import { formatTraceparent, runTraceId } from "@kobe/protocol";
import {
  idAttributes,
  runParentContext,
  sessionAttributes,
  telemetryState,
  trace,
  withSpan,
  type Span,
} from "@kobe/telemetry";
import type { Logger } from "pino";
import type { SandboxBus } from "./bus.js";
import {
  completeCommand,
  enqueueCommand,
  expireCommand,
  liveConnection,
  takeResult,
} from "./commands.js";
import type { WireTuning } from "./constants.js";
import type { ConnectionRegistry } from "./registry.js";
import { targetForThread } from "./slots.js";
import {
  SandboxWakeError,
  type CommandOutcome,
  type SandboxRouter,
  type SandboxTarget,
  type SandboxWaker,
  type SendOptions,
} from "./types.js";

interface Waiter {
  readonly teamId: string;
  check(): void;
}

/**
 * The routing API (`SandboxRouter`). Works on every replica: a command is a `sandbox_commands`
 * row plus a `cmd` hint to the replica holding the sandbox's socket (or a wake when there is
 * none: KOBE-25); the result comes back as the row's outcome plus a `res` hint, with polling as
 * the safety net for lost hints. A command never waits past its deadline.
 */
export class CommandRouter implements SandboxRouter {
  readonly #db: KobeDb;
  readonly #bus: SandboxBus;
  readonly #tuning: WireTuning;
  readonly #replicaId: string;
  readonly #registry: ConnectionRegistry;
  readonly #waker: SandboxWaker;
  readonly #log: Logger;
  readonly #waiters = new Map<string, Waiter>();
  /** Add a run trace context to start commands (KOBE-274): tracing is on. */
  readonly #traceRuns: boolean;
  #closed = false;

  constructor(options: {
    db: KobeDb;
    bus: SandboxBus;
    tuning: WireTuning;
    replicaId: string;
    registry: ConnectionRegistry;
    waker: SandboxWaker;
    log: Logger;
    traceRuns?: boolean;
  }) {
    this.#db = options.db;
    this.#bus = options.bus;
    this.#tuning = options.tuning;
    this.#replicaId = options.replicaId;
    this.#registry = options.registry;
    this.#waker = options.waker;
    this.#log = options.log;
    this.#traceRuns = options.traceRuns ?? false;
  }

  get waiting(): number {
    return this.#waiters.size;
  }

  /** A `res` hint (or a local completion) for a command requested here. */
  onResult(commandId: string): void {
    this.#waiters.get(commandId)?.check();
  }

  /** Hints may have been missed: every waiter re-reads. */
  resync(): void {
    for (const w of this.#waiters.values()) w.check();
  }

  close(): void {
    this.#closed = true;
  }

  startRun(
    target: SandboxTarget,
    run: Parameters<SandboxRouter["startRun"]>[1],
    options?: SendOptions,
  ) {
    return this.#send(target, "run.start", run.threadId, run.runId, options, {
      run_id: run.runId,
      thread_id: run.threadId,
      message: run.message,
      ...(run.attachments === undefined ? {} : { attachments: run.attachments }),
      ...(run.parentEntryId === undefined ? {} : { parent_entry_id: run.parentEntryId }),
      ...(run.config === undefined ? {} : { config: run.config }),
      ...(run.project === undefined ? {} : { project: run.project }),
      ...(run.mcp === undefined ? {} : { mcp: run.mcp }),
      ...(run.appCards === undefined ? {} : { app_cards: [...run.appCards] }),
      ...(run.viewing === undefined ? {} : { viewing: run.viewing }),
    });
  }

  steerRun(
    target: SandboxTarget,
    steer: Parameters<SandboxRouter["steerRun"]>[1],
    options?: SendOptions,
  ) {
    return this.#send(target, "run.steer", steer.threadId, steer.runId, options, {
      run_id: steer.runId,
      thread_id: steer.threadId,
      message: steer.message,
    });
  }

  stopRun(
    target: SandboxTarget,
    stop: Parameters<SandboxRouter["stopRun"]>[1],
    options?: SendOptions,
  ) {
    return this.#send(target, "run.stop", stop.threadId, stop.runId, options, {
      run_id: stop.runId,
      thread_id: stop.threadId,
      mode: stop.mode,
      reason: stop.reason,
    });
  }

  piCommand(
    target: SandboxTarget,
    request: Parameters<SandboxRouter["piCommand"]>[1],
    options?: SendOptions,
  ) {
    return this.#send(target, "pi.command", request.threadId, undefined, options, {
      thread_id: request.threadId,
      command: request.command,
    });
  }

  evalPrepare(
    target: SandboxTarget,
    request: Parameters<SandboxRouter["evalPrepare"]>[1],
    options?: SendOptions,
  ) {
    return this.#send(target, "eval.prepare", request.threadId, undefined, options, {
      thread_id: request.threadId,
      files: request.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
    });
  }

  evalSnapshot(
    target: SandboxTarget,
    request: Parameters<SandboxRouter["evalSnapshot"]>[1],
    options?: SendOptions,
  ) {
    return this.#send(target, "eval.snapshot", request.threadId, undefined, options, {
      thread_id: request.threadId,
      roots: [...request.roots],
      hash_paths: [...request.hashPaths],
    });
  }

  evalRead(
    target: SandboxTarget,
    request: Parameters<SandboxRouter["evalRead"]>[1],
    options?: SendOptions,
  ) {
    return this.#send(target, "eval.read", request.threadId, undefined, options, {
      thread_id: request.threadId,
      files: request.files.map((f) => ({ path: f.path, size: f.size })),
    });
  }

  compactThread(
    target: SandboxTarget,
    request: Parameters<SandboxRouter["compactThread"]>[1],
    options?: SendOptions,
  ) {
    return this.#send(target, "thread.compact", request.threadId, request.runId, options, {
      run_id: request.runId,
      thread_id: request.threadId,
      ...(request.focus === undefined ? {} : { focus: request.focus }),
      model: request.model,
      ...(request.modelLimits === undefined ? {} : { model_limits: request.modelLimits }),
    });
  }

  /**
   * Whether the sandbox is connected. With `threadId`, the sandbox that serves that thread
   * (KOBE-325: an eval thread's own sandbox, else the member's).
   */
  async isConnected(target: SandboxTarget, threadId?: string): Promise<boolean> {
    const live = await withTeam(this.#db, target.teamId, async (tx) => {
      if (threadId === undefined) return liveConnection(tx, target, this.#tuning.staleConnectionMs);
      const res = await tx.execute<{ skill_eval: boolean }>(sql`
        SELECT skill_eval FROM threads WHERE team_id = ${target.teamId} AND id = ${threadId}`);
      const forThread = targetForThread(
        target.teamId,
        target.userId,
        threadId,
        res.rows[0]?.skill_eval === true,
      );
      return liveConnection(tx, forThread, this.#tuning.staleConnectionMs);
    });
    return live !== undefined;
  }

  async #send(
    target: SandboxTarget,
    kind: SandboxCommandKind,
    threadId: string,
    runId: string | undefined,
    options: SendOptions | undefined,
    frame: Record<string, unknown>,
  ): Promise<CommandOutcome> {
    if (this.#closed) {
      return { ok: false, error: { code: "unavailable", message: "the server is shutting down" } };
    }
    // A run's commands are spans of the run's trace (KOBE-274), linked to whatever caused them.
    const cause = trace.getActiveSpan()?.spanContext();
    const runScoped =
      runId === undefined
        ? {}
        : {
            parent: runParentContext(runId),
            ...(cause && trace.isSpanContextValid(cause) ? { links: [{ context: cause }] } : {}),
          };
    return withSpan(
      "sandbox.command",
      {
        ...runScoped,
        attributes: {
          ...idAttributes({
            teamId: target.teamId,
            userId: target.userId,
            threadId,
            runId,
          }),
          ...(runId === undefined ? {} : sessionAttributes({ threadId, userId: target.userId })),
          "kobe.command.kind": kind,
        },
      },
      async (span) => {
        const sent = this.#withTraceContext(kind, runId, span, frame);
        const outcome = await this.#sendQueued(target, kind, threadId, runId, options, sent);
        span.setAttribute("kobe.outcome", outcome.ok ? "ok" : outcome.error.code);
        return outcome;
      },
    );
  }

  /**
   * `run.start` / `thread.compact` carry the run's trace context (traceparent = this command span)
   * when the run is traced; the delivering replica strips it for agents without `trace_spans`.
   */
  #withTraceContext(
    kind: SandboxCommandKind,
    runId: string | undefined,
    span: Span,
    frame: Record<string, unknown>,
  ): Record<string, unknown> {
    if (runId === undefined || !this.#traceRuns || !span.isRecording()) return frame;
    if (kind !== "run.start" && kind !== "thread.compact") return frame;
    return {
      ...frame,
      trace: {
        traceparent: formatTraceparent(runTraceId(runId), span.spanContext().spanId),
        capture_content: telemetryState().captureContent,
      },
    };
  }

  async #sendQueued(
    target: SandboxTarget,
    kind: SandboxCommandKind,
    threadId: string,
    runId: string | undefined,
    options: SendOptions | undefined,
    frame: Record<string, unknown>,
  ): Promise<CommandOutcome> {
    const timeoutMs = options?.timeoutMs ?? this.#tuning.commandTimeoutMs[kind];
    const queued = await enqueueCommand(this.#db, this.#bus, {
      target,
      kind,
      threadId,
      ...(runId === undefined ? {} : { runId }),
      frame,
      requesterReplica: this.#replicaId,
      timeoutMs,
      staleMs: this.#tuning.staleConnectionMs,
    });
    if ("error" in queued) {
      return {
        ok: false,
        error: { code: "thread_not_found", message: "no such thread for this sandbox" },
      };
    }
    if (!queued.live && queued.evalThread) {
      // An eval thread's sandbox (KOBE-325) is started by the eval runner, never woken here: the
      // command waits for it to connect (or times out). The member's sandbox is never woken for it.
    } else if (!queued.live) {
      const starts = kind === "run.start" || kind === "thread.compact";
      void this.#wakeFor(target, queued.id, timeoutMs, starts ? runId : undefined);
    } else if (queued.live.replicaId === this.#replicaId) {
      this.#registry.get(queued.live.connectionId)?.pokeCommands();
    }
    return this.#await(target.teamId, queued.id, timeoutMs);
  }

  /**
   * Wakes the sandbox for a waiting command. A definitive failure (no isolation runtime,
   * offboarded, not a member) fails the command at once; a transient one (API timeout, a pod slow
   * to appear) is retried with jittered backoff while the command still waits and the sandbox is
   * not connected, within a budget that ends before the command's deadline; then the command
   * fails `sandbox_unavailable` instead of timing out silently.
   */
  async #wakeFor(
    target: SandboxTarget,
    id: string,
    timeoutMs: number,
    runId: string | undefined,
  ): Promise<void> {
    const budget = Math.min(this.#tuning.wakeRetryBudgetMs, Math.max(0, timeoutMs - 2_000));
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#waker.wake(target, runId === undefined ? undefined : { runId });
        return;
      } catch (err) {
        if (err instanceof SandboxWakeError) {
          this.#log.warn({ err }, "sandbox wake refused");
          this.#fail(target.teamId, id, err);
          return;
        }
        this.#log.warn({ err, attempt }, "sandbox wake failed");
        const delay = Math.random() * Math.min(10_000, this.#tuning.wakeRetryBaseMs * 2 ** attempt);
        if (this.#closed || !this.#waiters.has(id)) return;
        if (Date.now() + delay - started >= budget) {
          this.#fail(
            target.teamId,
            id,
            new SandboxWakeError("sandbox_unavailable", "the sandbox could not be started"),
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay).unref());
        if (this.#closed || !this.#waiters.has(id)) return;
        if (await this.isConnected(target).catch(() => false)) return;
      }
    }
  }

  #fail(teamId: string, id: string, err: SandboxWakeError): void {
    withTeam(this.#db, teamId, (tx) =>
      completeCommand(tx, this.#bus, teamId, id, {
        ok: false,
        error: { code: err.code, message: err.message },
      }),
    )
      .then(() => this.onResult(id))
      .catch((e: unknown) => this.#log.warn({ err: e }, "could not fail a command"));
  }

  #await(teamId: string, id: string, timeoutMs: number): Promise<CommandOutcome> {
    return new Promise<CommandOutcome>((resolve) => {
      let done = false;
      let reading = false;
      let again = false;
      const finish = (outcome: CommandOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        clearInterval(poll);
        this.#waiters.delete(id);
        resolve(outcome);
      };
      const check = () => {
        if (done) return;
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        takeResult(this.#db, teamId, id)
          .then((outcome) => {
            if (outcome) finish(outcome);
          })
          .catch((err: unknown) => this.#log.warn({ err }, "reading a command result failed"))
          .finally(() => {
            reading = false;
            if (again) {
              again = false;
              check();
            }
          });
      };
      const deadline = setTimeout(() => {
        expireCommand(this.#db, teamId, id)
          .then(finish)
          .catch(() =>
            finish({
              ok: false,
              error: { code: "timeout", message: "the sandbox did not answer in time" },
            }),
          );
      }, timeoutMs);
      deadline.unref();
      const poll = setInterval(check, this.#tuning.resultPollMs);
      poll.unref();
      this.#waiters.set(id, { teamId, check });
    });
  }
}
