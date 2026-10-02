import type {
  HelloAckFrame,
  HelloFrame,
  SandboxToServerFrame,
  ServerToSandboxFrame,
} from "@kobe/protocol";
import type { Config } from "./config.js";
import type { PiExit, PiRecord } from "./pi/pi-process.js";
import { PolicyBroker } from "./policy/broker.js";
import { ThreadManager } from "./threads/manager.js";
import { fail, type CommandOutcome } from "./threads/outcome.js";
import { WireClient, type FatalReason, type WireLogger } from "./wire/client.js";
import { encodeOutbound } from "./wire/encode.js";
import { Outbox } from "./wire/outbox.js";
import type { BackoffPolicy } from "./wire/backoff.js";

/**
 * kobe-sandbox-agent: glues the outbound wire (WireClient), per-run delivery (Outbox), the Pi
 * supervisor (ThreadManager) and the kobe-policy relay (PolicyBroker) together, implementing the
 * sandbox side of packages/protocol `sandbox-wire/connection.ts`.
 */
export interface AgentDeps {
  readonly config: Config;
  readonly logger: WireLogger;
  readonly readToken: () => Promise<string>;
  readonly agentVersion: string;
  readonly piVersion: string;
  readonly home: string;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly onExit: (code: number) => void;
  readonly backoff?: BackoffPolicy;
  readonly heartbeatTimeoutMs?: number;
}

const MAX_REMEMBERED_COMMANDS = 4096;
const MAX_QUEUED_EXITS = 64;
const COMMAND_FRAMES = new Set([
  "run.start",
  "run.steer",
  "run.stop",
  "pi.command",
  "session.restore",
]);
const DRAIN_ON_FATAL_MS = 5000;

type PiExitedFrameT = Extract<SandboxToServerFrame, { type: "pi.exited" }>;

export class Agent {
  readonly #deps: AgentDeps;
  readonly #outbox: Outbox;
  readonly #wire: WireClient;
  readonly #threads: ThreadManager;
  readonly #broker: PolicyBroker;
  /** Command ids seen on the current connection (ids are not portable across reconnects). */
  #seenCommands = new Set<string>();
  #queuedExits: PiExitedFrameT[] = [];
  #stopping = false;

  constructor(deps: AgentDeps) {
    this.#deps = deps;
    const { config, logger } = deps;
    this.#outbox = new Outbox(config.outboxMaxBytes);
    this.#broker = new PolicyBroker({ send: (frame) => this.#wire.send(frame) });
    this.#threads = new ThreadManager({
      bin: config.piBin,
      workspaceDir: config.workspaceDir,
      sessionDir: config.sessionDir,
      home: deps.home,
      parentEnv: deps.parentEnv,
      maxProcesses: config.maxPiProcesses,
      idleMs: config.piIdleMs,
      restoreMaxBytes: config.restoreMaxBytes,
      hooks: {
        runStarted: (runId, threadId) => this.#outbox.open(runId, threadId),
        piEvent: (runId, threadId, event) => this.#emitPiEvent(runId, threadId, event),
        runEnded: (runId) => {
          this.#outbox.finish(runId);
          this.#broker.failRun(runId, "run ended");
        },
        uiRequest: (threadId, runId, request) => {
          this.#wire.send({
            v: 1,
            type: "pi.ui_request",
            thread_id: threadId,
            ...(runId === undefined ? {} : { run_id: runId }),
            request,
          });
        },
        piExited: (threadId, exit) => this.#reportExit(threadId, exit),
        policyCheck: (threadId, runId, check, reply) =>
          this.#broker.check(threadId, runId, check, reply),
        diagnostic: (threadId, message) => logger.debug({ thread_id: threadId }, message),
      },
    });
    this.#wire = new WireClient({
      url: config.connectUrl,
      readToken: deps.readToken,
      hello: () => this.#hello(),
      onReady: (ack) => this.#onReady(ack),
      onFrame: (frame) => this.#onFrame(frame),
      onDisconnected: () => {
        this.#broker.failAll("connection to Kobe server lost");
        void this.#threads.abortRestores();
      },
      onFatal: (reason) => void this.#onFatal(reason),
      logger,
      ...(deps.backoff === undefined ? {} : { backoff: deps.backoff }),
      ...(deps.heartbeatTimeoutMs === undefined
        ? {}
        : { heartbeatTimeoutMs: deps.heartbeatTimeoutMs }),
    });
  }

  start(): void {
    this.#wire.start();
  }

  /** Graceful stop: drain runs up to `deadlineMs`, close Pi processes, close the socket. */
  async stop(deadlineMs: number, code = 0): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    await this.#threads.shutdown(deadlineMs);
    await this.#wire.stop(1000, "agent stopping");
    this.#deps.onExit(code);
  }

  /** Synchronous last resort on process exit: no Pi process group outlives the agent. */
  killAll(): void {
    this.#threads.killAll();
  }

  #hello(): HelloFrame {
    return {
      v: 1,
      type: "hello",
      sandbox_id: this.#deps.config.sandboxId,
      agent_version: this.#deps.agentVersion,
      pi_version: this.#deps.piVersion,
      runs: this.#outbox.helloRuns(),
    };
  }

  #onReady(ack: HelloAckFrame): void {
    this.#seenCommands = new Set();
    this.#outbox.resetConnectionState();
    const listed = new Map(ack.runs.map((run) => [run.run_id, run]));
    for (const runId of this.#outbox.runIds()) {
      const run = listed.get(runId);
      if (run === undefined) {
        // The server no longer leases this run to us (connection.ts): abort and forget it.
        this.#threads.abortRun(runId);
        this.#outbox.drop(runId);
        continue;
      }
      if (!this.#outbox.canResendFrom(runId, run.durable_seq + 1)) {
        this.#abandonRun(runId); // the server lost frames we already dropped as acked
        continue;
      }
      if (run.durable_seq > 0) this.#outbox.ack(runId, run.durable_seq);
      for (const text of this.#outbox.resend(runId, run.durable_seq + 1)) this.#wire.sendText(text);
    }
    const exits = this.#queuedExits;
    this.#queuedExits = [];
    for (const frame of exits) this.#wire.send(frame);
    for (const dialog of this.#threads.pendingDialogs()) {
      this.#deps.logger.debug({ thread_id: dialog.threadId }, "re-sending pending UI request");
      this.#wire.send({
        v: 1,
        type: "pi.ui_request",
        thread_id: dialog.threadId,
        ...(dialog.runId === undefined ? {} : { run_id: dialog.runId }),
        request: dialog.request,
      });
    }
  }

  #onFrame(frame: ServerToSandboxFrame): void {
    if (COMMAND_FRAMES.has(frame.type)) {
      void this.#runCommand(frame);
      return;
    }
    switch (frame.type) {
      case "pi.ui_response":
        this.#threads.uiResponse(frame);
        return;
      case "policy.pending":
        this.#broker.onPending(frame);
        return;
      case "policy.result":
        this.#broker.onResult(frame);
        return;
      case "ack":
        this.#outbox.ack(frame.run_id, frame.seq);
        return;
      case "resend":
        if (!this.#outbox.canResendFrom(frame.run_id, frame.from_seq)) {
          if (this.#outbox.has(frame.run_id)) this.#abandonRun(frame.run_id);
          return;
        }
        for (const text of this.#outbox.resend(frame.run_id, frame.from_seq)) {
          this.#wire.sendText(text);
        }
        return;
      case "shutdown":
        this.#deps.logger.info({ reason: frame.reason }, "server requested shutdown");
        void this.stop(frame.deadline_ms, 0);
        return;
      case "error":
        this.#deps.logger.warn({ code: frame.code, ref: frame.ref }, "server reported an error");
        return;
      default:
        return;
    }
  }

  async #runCommand(frame: ServerToSandboxFrame): Promise<void> {
    if (!("command_id" in frame)) return;
    const commandId = frame.command_id;
    if (this.#seenCommands.has(commandId)) return;
    this.#remember(commandId);
    // Command ids are per connection (connection.ts leasing): a result for a command that arrived
    // on an earlier connection must not be sent on a later one; the server re-issues instead.
    const epoch = this.#wire.epoch;
    let outcome: CommandOutcome;
    try {
      outcome = await this.#execute(frame);
    } catch (error) {
      this.#deps.logger.warn({ err: (error as Error).message, type: frame.type }, "command failed");
      outcome = fail("internal", "command failed in the sandbox agent");
    }
    if (this.#wire.epoch !== epoch || !this.#wire.ready) {
      this.#deps.logger.debug({ command_id: commandId }, "result dropped: connection changed");
      return;
    }
    this.#sendResult(commandId, outcome);
  }

  #execute(frame: ServerToSandboxFrame): Promise<CommandOutcome> {
    switch (frame.type) {
      case "run.start":
        return this.#threads.startRun(frame);
      case "run.steer":
        return this.#threads.steerRun(frame);
      case "run.stop":
        return this.#threads.stopRun(frame);
      case "pi.command":
        return this.#threads.piCommand(frame);
      case "session.restore":
        return this.#threads.restore(frame);
      default:
        return Promise.resolve(fail("internal", "not a command"));
    }
  }

  #sendResult(commandId: string, outcome: CommandOutcome): void {
    const sent = outcome.ok
      ? this.#wire.send({
          v: 1,
          type: "command.result",
          command_id: commandId,
          ok: true,
          ...(outcome.data === undefined ? {} : { data: outcome.data }),
        })
      : false;
    if (sent) return;
    const failure = outcome.ok
      ? fail("frame_too_large", "result does not fit in one frame")
      : outcome;
    if (failure.ok) return;
    this.#wire.send({
      v: 1,
      type: "command.result",
      command_id: commandId,
      ok: false,
      error: { code: failure.code, message: failure.message },
    });
  }

  #remember(commandId: string): void {
    this.#seenCommands.add(commandId);
    if (this.#seenCommands.size > MAX_REMEMBERED_COMMANDS) {
      const oldest = this.#seenCommands.values().next().value;
      if (oldest !== undefined) this.#seenCommands.delete(oldest);
    }
  }

  #emitPiEvent(runId: string, threadId: string, event: PiRecord): void {
    const appended = this.#outbox.append(runId, (seq) =>
      encodePiEvent(runId, threadId, seq, event),
    );
    if (!appended.ok) {
      if (appended.reason === "overflow") this.#abandonRun(runId);
      return;
    }
    this.#wire.sendText(appended.text);
  }

  /**
   * The un-acked buffer is full: give the run up. Abort it in Pi, forget its frames and reconnect,
   * so `hello` no longer lists it and the server interrupts it (D14).
   */
  #abandonRun(runId: string): void {
    this.#deps.logger.warn({ run_id: runId }, "run cannot be delivered; abandoning it");
    this.#threads.abortRun(runId);
    this.#outbox.drop(runId);
    this.#wire.reconnect();
  }

  #reportExit(threadId: string, exit: PiExit): void {
    const frame: PiExitedFrameT = {
      v: 1,
      type: "pi.exited",
      thread_id: threadId,
      exit_code: exit.exitCode,
      signal: exit.signal,
      stderr_tail: exit.stderrTail,
    };
    this.#deps.logger.warn({ thread_id: threadId, code: exit.exitCode }, "Pi process exited");
    if (this.#wire.send(frame)) return;
    if (this.#queuedExits.length < MAX_QUEUED_EXITS) this.#queuedExits.push(frame);
  }

  async #onFatal(reason: FatalReason): Promise<void> {
    this.#deps.logger.warn({ reason }, "server closed the sandbox wire for good");
    await this.stop(DRAIN_ON_FATAL_MS, reason === "unsupported_version" ? 1 : 0);
  }
}

/**
 * Build one `pi.event` frame. An event the server's decoder would reject (too large, too deep) is
 * replaced by a `kobe.event_dropped` record (an unknown type, which the server ignores), so the seq
 * stays gapless and the run keeps going.
 */
export function encodePiEvent(
  runId: string,
  threadId: string,
  seq: number,
  event: PiRecord,
): string {
  const frame = {
    v: 1 as const,
    type: "pi.event" as const,
    run_id: runId,
    thread_id: threadId,
    seq,
  };
  const encoded = encodeOutbound({ ...frame, event });
  if (encoded.ok) return encoded.text;
  const placeholder = encodeOutbound({
    ...frame,
    event: {
      type: "kobe.event_dropped",
      original_type: event.type.slice(0, 64),
      reason: encoded.code,
    },
  });
  if (!placeholder.ok) throw new Error("cannot encode placeholder pi.event");
  return placeholder.text;
}
