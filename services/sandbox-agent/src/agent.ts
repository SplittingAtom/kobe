import {
  CAPABILITY_ARTIFACTS,
  CAPABILITY_BUILTIN_SKILLS,
  CAPABILITY_FILES,
  CAPABILITY_RUN_TOKEN,
  CAPABILITY_SKILL_BUNDLES,
  KOBE_EVENT_DROPPED_TYPE,
  type HelloAckFrame,
  type HelloFrame,
  type KobeEventDropped,
  type RunStartFrame,
  type SandboxToServerFrame,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import type { Config } from "./config.js";
import type { PiExit, PiRecord } from "./pi/pi-process.js";
import { PolicyBroker } from "./policy/broker.js";
import { ArtifactBroker } from "./tools/broker.js";
import { FileShareBroker } from "./tools/share-broker.js";
import { toolsError } from "./tools/channel.js";
import type { PushedFile } from "./workspace/sync.js";
import type { SkillStore } from "./skills/store.js";
import { ThreadManager } from "./threads/manager.js";
import { fail, type CommandOutcome } from "./threads/outcome.js";
import { WireClient, type FatalReason, type WireLogger } from "./wire/client.js";
import { encodeOutbound } from "./wire/encode.js";
import { Outbox } from "./wire/outbox.js";
import type { BackoffPolicy } from "./wire/backoff.js";
import type { EgressWiring } from "./egress/egress-wiring.js";
import type { ModelWiring } from "./models/types.js";
import type { PiIdentities } from "./pi/identities.js";
import type { ExecWiring } from "./threads/exec-wiring.js";

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
  readonly policyReadyTimeoutMs?: number;
  /**
   * Root-owned extensions (or `builtin:<name>`) loaded before kobe-policy, which is always last
   * (KOBE-62 adds `builtin:mcp` here).
   */
  readonly extensions?: readonly string[];
  /** Model gateway wiring (KOBE-41); absent when the sandbox has no model access. */
  readonly models?: ModelWiring | undefined;
  /** Egress for Pi's tools (KOBE-39); absent outside Kobe's pods. */
  readonly egress?: EgressWiring | undefined;
  /** Pi identities (KOBE-71); absent: Pi runs as the agent's uid. */
  readonly identities?: PiIdentities | undefined;
  /** Workspace sync (KOBE-27): restore before runs, push after them and before stopping. */
  readonly workspace?: WorkspaceHooks;
  /**
   * kobe-tools (KOBE-128): the root-owned extension file, as checked at startup. Present: Pi gets
   * the fd-4 channel and the agent announces the `artifacts` capability.
   */
  readonly toolsExtension?: string | undefined;
  /**
   * The tool executor (KOBE-167): the root-owned kobe-exec extension file and where the executor
   * program lives. Present: every Pi's built-in tools run in an executor under its partner uid.
   */
  readonly exec?: { readonly extension: string; readonly wiring: ExecWiring } | undefined;
  /** Skills store (KOBE-82); absent: runs that list skills fail instead of starting without them. */
  readonly skills?: SkillStore;
}

/** What the agent needs of workspace sync (`workspace/sync.ts`). */
export interface WorkspaceHooks {
  beforeRun(frame: RunStartFrame): Promise<void>;
  runEnded(): void;
  /**
   * Push one file now and return its synced entry (`share_file`, KOBE-149). Absent: this agent
   * has no workspace sync, so it does not announce the `files` capability.
   */
  pushPath?(rel: string): Promise<PushedFile>;
  flush(deadlineMs: number): Promise<unknown>;
}

/** The final workspace push before the process exits (inside the pod's 30 s grace period). */
export const WORKSPACE_FLUSH_MS = 15_000;

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
  readonly #artifacts: ArtifactBroker;
  readonly #shares: FileShareBroker;
  /** Command ids seen on the current connection (ids are not portable across reconnects). */
  #seenCommands = new Set<string>();
  #queuedExits: { runId: string; frame: PiExitedFrameT }[] = [];
  #stopping = false;

  constructor(deps: AgentDeps) {
    this.#deps = deps;
    const { config, logger } = deps;
    this.#outbox = new Outbox(config.outboxMaxBytes);
    this.#broker = new PolicyBroker({ send: (frame) => this.#wire.send(frame) });
    this.#artifacts = new ArtifactBroker({ send: (frame) => this.#wire.send(frame) });
    const pushPath = deps.workspace?.pushPath?.bind(deps.workspace);
    this.#shares = new FileShareBroker({
      root: config.workspaceDir,
      send: (frame) => this.#wire.send(frame),
      pushPath: pushPath ?? (() => Promise.reject(new Error("workspace sync is not available"))),
    });
    this.#threads = new ThreadManager({
      bin: config.piBin,
      runtimeDir: config.piRuntimeDir,
      models: deps.models,
      egress: deps.egress,
      policyExtension: config.policyExtension,
      toolsExtension: deps.toolsExtension,
      exec: deps.exec?.wiring,
      execExtension: deps.exec?.extension,
      shareFiles: this.#filesEnabled(),
      ...(deps.extensions === undefined ? {} : { extensions: deps.extensions }),
      ...(deps.policyReadyTimeoutMs === undefined
        ? {}
        : { policyReadyTimeoutMs: deps.policyReadyTimeoutMs }),
      workspaceDir: config.workspaceDir,
      sessionDir: config.sessionDir,
      home: deps.home,
      identities: deps.identities,
      parentEnv: deps.parentEnv,
      ...(deps.skills === undefined ? {} : { skills: deps.skills }),
      ...(config.builtinSkillsDir === undefined
        ? {}
        : { builtinSkillsDir: config.builtinSkillsDir }),
      maxProcesses: config.maxPiProcesses,
      idleMs: config.piIdleMs,
      restoreMaxBytes: config.restoreMaxBytes,
      ...(deps.workspace === undefined
        ? {}
        : {
            beforeRun: (frame: RunStartFrame) =>
              deps.workspace?.beforeRun(frame) ?? Promise.resolve(),
          }),
      hooks: {
        runStarted: (runId, threadId) => this.#outbox.open(runId, threadId),
        piEvent: (runId, threadId, event) => this.#emitPiEvent(runId, threadId, event),
        runEnded: (runId) => {
          this.#outbox.finish(runId);
          this.#broker.failRun(runId, "run ended");
          this.#artifacts.failRun(runId, "run ended");
          this.#shares.failRun(runId, "run ended");
          deps.workspace?.runEnded();
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
        piExited: (threadId, runId, exit) => this.#reportExit(threadId, runId, exit),
        policyCheck: (threadId, runId, check, reply) =>
          this.#broker.check(threadId, runId, check, reply),
        policyCancel: (threadId, requestId) => {
          this.#broker.cancel(threadId, requestId);
        },
        policyChannelClosed: (threadId, reason) => {
          logger.debug({ thread_id: threadId, reason }, "policy channel closed");
          this.#broker.failThread(threadId, reason);
        },
        toolsRequest: (threadId, runId, request, reply) => {
          if (request.op === "file.share") {
            if (this.#filesEnabled()) this.#shares.share(threadId, runId, request, reply);
            else reply(toolsError(request.id, "not_allowed", "file sharing is not available"));
            return;
          }
          this.#artifacts.put(threadId, runId, request, reply);
        },
        toolsChannelClosed: (threadId, reason) => {
          logger.debug({ thread_id: threadId, reason }, "tools channel closed");
          this.#artifacts.failThread(threadId, reason);
          this.#shares.failThread(threadId, reason);
        },
        diagnostic: (threadId, message) => logger.debug({ thread_id: threadId }, message),
        warning: (threadId, message) => logger.warn({ thread_id: threadId }, message),
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
        this.#artifacts.failAll("connection to Kobe server lost");
        this.#shares.failAll("connection to Kobe server lost");
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
    // Pi is gone, so the workspace is settled: push what changed since the last sync.
    await this.#deps.workspace?.flush(WORKSPACE_FLUSH_MS);
    await this.#wire.stop(1000, "agent stopping");
    this.#deps.onExit(code);
  }

  /** Per-run delivery cursors (diagnostics and tests). */
  deliveryState(): { run_id: string; last_seq: number; acked_seq: number }[] {
    return this.#outbox.runIds().map((runId) => {
      const run = this.#outbox.get(runId);
      return { run_id: runId, last_seq: run?.lastSeq ?? 0, acked_seq: run?.ackedSeq ?? 0 };
    });
  }

  /** Synchronous last resort on process exit: no Pi process group outlives the agent. */
  killAll(): void {
    this.#threads.killAll();
  }

  /**
   * `share_file` needs the tools channel (fd 4) and workspace sync (push-then-share): without
   * either this agent neither registers the tool nor announces `files`.
   */
  #filesEnabled(): boolean {
    return this.#deps.toolsExtension !== undefined && this.#deps.workspace?.pushPath !== undefined;
  }

  #hello(): HelloFrame {
    const capabilities = [
      ...(this.#deps.skills === undefined ? [] : [CAPABILITY_SKILL_BUNDLES]),
      ...(this.#deps.config.builtinSkillsDir === undefined ? [] : [CAPABILITY_BUILTIN_SKILLS]),
      ...(this.#deps.toolsExtension === undefined ? [] : [CAPABILITY_ARTIFACTS]),
      ...(this.#filesEnabled() ? [CAPABILITY_FILES] : []),
      // The run token reaches Pi through the models extension, so only with model wiring.
      ...(this.#deps.models === undefined ? [] : [CAPABILITY_RUN_TOKEN]),
    ];
    return {
      v: 1,
      type: "hello",
      sandbox_id: this.#deps.config.sandboxId,
      agent_version: this.#deps.agentVersion,
      pi_version: this.#deps.piVersion,
      runs: this.#outbox.helloRuns(),
      // Optional features, so the server sends their fields only to agents that can use them.
      ...(capabilities.length === 0 ? {} : { capabilities }),
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
    // Only threads leased on this connection (through a listed run) may be named: anything else
    // would be a lease violation and get the connection closed, again and again.
    const exits = this.#queuedExits;
    this.#queuedExits = [];
    for (const { runId, frame } of exits) if (listed.has(runId)) this.#wire.send(frame);
    this.#threads.cancelDialogsExcept(new Set(listed.keys()));
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
      case "artifact.result":
        this.#artifacts.onResult(frame);
        return;
      case "file.share_result":
        this.#shares.onResult(frame);
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

  #reportExit(threadId: string, runId: string | undefined, exit: PiExit): void {
    const frame: PiExitedFrameT = {
      v: 1,
      type: "pi.exited",
      thread_id: threadId,
      exit_code: exit.exitCode,
      signal: exit.signal,
      stderr_tail: exit.stderrTail,
    };
    this.#deps.logger.warn({ thread_id: threadId, code: exit.exitCode }, "Pi process exited");
    // Without an active run the thread is not leased to us: the server learns nothing it needs.
    if (runId === undefined) return;
    if (this.#wire.send(frame)) return;
    if (this.#queuedExits.length < MAX_QUEUED_EXITS) this.#queuedExits.push({ runId, frame });
  }

  async #onFatal(reason: FatalReason): Promise<void> {
    this.#deps.logger.warn({ reason }, "server closed the sandbox wire for good");
    await this.stop(DRAIN_ON_FATAL_MS, reason === "unsupported_version" ? 1 : 0);
  }
}

/**
 * Build one `pi.event` frame. An event the server's decoder would reject (too large, too deep) is
 * replaced by a `kobe.event_dropped` record (`kobeEventDroppedSchema` in @kobe/protocol: not a Pi
 * type, so the server accepts it without translating it), so the seq stays gapless and the run
 * keeps going.
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
      type: KOBE_EVENT_DROPPED_TYPE,
      original_type: event.type.slice(0, 64),
      reason: encoded.code,
    } satisfies KobeEventDropped,
  });
  if (!placeholder.ok) throw new Error("cannot encode placeholder pi.event");
  return placeholder.text;
}
