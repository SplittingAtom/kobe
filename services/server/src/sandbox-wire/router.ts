import { withTeam, type KobeDb, type SandboxCommandKind } from "@kobe/db";
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
  #closed = false;

  constructor(options: {
    db: KobeDb;
    bus: SandboxBus;
    tuning: WireTuning;
    replicaId: string;
    registry: ConnectionRegistry;
    waker: SandboxWaker;
    log: Logger;
  }) {
    this.#db = options.db;
    this.#bus = options.bus;
    this.#tuning = options.tuning;
    this.#replicaId = options.replicaId;
    this.#registry = options.registry;
    this.#waker = options.waker;
    this.#log = options.log;
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

  async isConnected(target: SandboxTarget): Promise<boolean> {
    const live = await withTeam(this.#db, target.teamId, (tx) =>
      liveConnection(tx, target, this.#tuning.staleConnectionMs),
    );
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
    if (!queued.live) {
      this.#waker.wake(target).catch((err: unknown) => {
        this.#log.warn({ err }, "sandbox wake failed");
        // Waiting cannot help (no isolation runtime, sandbox offboarded): fail the command now.
        if (err instanceof SandboxWakeError) this.#fail(target.teamId, queued.id, err);
      });
    } else if (queued.live.replicaId === this.#replicaId) {
      this.#registry.get(queued.live.connectionId)?.pokeCommands();
    }
    return this.#await(target.teamId, queued.id, timeoutMs);
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
