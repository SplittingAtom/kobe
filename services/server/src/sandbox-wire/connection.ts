import { randomUUID } from "node:crypto";
import {
  CAPABILITY_SESSION_RENEW,
  CAPABILITY_SYNC_CONFLICTS,
  CAPABILITY_TRACE_SPANS,
  CAPABILITY_WORKSPACE_MOVES,
  CAPABILITY_WORKSPACE_SYNC_NOW,
  SANDBOX_CLOSE_CODES,
  decodeSandboxFrame,
  type HelloFrame,
  type PiEventFrame,
  type SandboxCloseReason,
  type SandboxErrorCode,
  type SandboxToServerFrame,
  type ServerToSandboxFrame,
  type WorkspaceConflictFrame,
} from "@kobe/protocol";
import type WebSocket from "ws";
import { AllowedArtifactCalls } from "../artifacts/allowed.js";
import { RecalledItems } from "../memory/recalled.js";
import {
  DeniedEventBuckets,
  FrameRate,
  frameSizeOk,
  MAX_BUFFERED_BYTES,
} from "./connection-limits.js";
import type { LeaseViolation, SandboxLimit, WireContext } from "./context.js";
import { CommandDelivery, type IssuedCommand } from "./delivery.js";
import { helloRuns, reconcileOrphans, recordHelloTiming } from "./frames/hello.js";
import { onPolicyCheck, type PolicyCheckPort } from "./frames/policy.js";
import type { ConnectionPort } from "./frames/port.js";
import {
  onBranchSummaryResult,
  onCommandResult,
  onCompactResult,
  type CommandResultPort,
} from "./frames/results.js";
import { failOversizedRun, interruptRun } from "./frames/run-end.js";
import { newRunIngest } from "./frames/ingest.js";
import { onNotebookOutput } from "./frames/notebook-output.js";
import { onUiRequest } from "./frames/ui-request.js";
import { onLegacyWebSearch, WorkspaceSyncAsks } from "./frames/workspace-sync.js";
import { toolFrameSpecs } from "./frames/tool-frames.js";
import { onTraceSpans } from "./frames/trace-spans.js";
import {
  isToolFrame,
  runToolFrame,
  type ToolFrameGate,
  type ToolFrameSpecs,
} from "./gated-frame.js";
import { NotebookIntake } from "./notebook-intake.js";
import { admitPiVersion } from "./pi-version.js";
import { LeaseBook } from "./leases.js";
import type { ConnectionRegistry, RegisteredConnection } from "./registry.js";
import type { RunIngest } from "./ingest.js";
import { RunChecks } from "./run-checks.js";
import { runLatency, type RunLatency } from "./run-latency-spans.js";
import type { InterruptCause, LeasedRun } from "./run-state.js";
import { SessionExpiry } from "./session-expiry.js";
import { ConflictRate, onWorkspaceConflict } from "./sync-conflict.js";
import { TraceFrameRate, type RunOwner, type TraceIntake } from "./trace-intake.js";
import type { SandboxTarget } from "./types.js";

export { admitPiVersion, supportedPiVersion } from "./pi-version.js";

export interface ConnectionClaims {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
  /** A skill eval's ephemeral sandbox (KOBE-325): its eval thread, from the signed token. */
  readonly evalThreadId?: string;
  /** Session token `exp` (seconds since the epoch). */
  readonly exp: number;
}

type State = "hello" | "starting" | "ready" | "closed";

/**
 * One authenticated sandbox WebSocket (D13, `@kobe/protocol` sandbox-wire/connection.ts):
 * `hello` → registration and leases → `hello.ack`, then inbound frames checked against this
 * connection's leases (runs, threads, command ids), heartbeats, periodic revalidation of the
 * principal, and command delivery. Never trusts a frame beyond what its lease allows: a frame
 * naming anything never leased here closes the connection with `lease_violation`.
 */
export class SandboxConnection implements RegisteredConnection {
  readonly id = randomUUID();
  readonly target: SandboxTarget;
  readonly sandboxId: string;
  readonly #ctx: WireContext;
  readonly #socket: WebSocket;
  readonly #registry: ConnectionRegistry;
  readonly #leases = new LeaseBook();
  /** `workspace.conflict` frames (KOBE-492): a few per minute per connection. */
  readonly #conflictRate = new ConflictRate();
  readonly #uiSeen = new Set<string>();
  readonly #policyPending = new Map<string, AbortController>();
  readonly #policyAnswered = new Set<string>();
  /** Artifact tool calls this connection's policy checks allowed (D-3 of KOBE-55). */
  readonly #allowedArtifacts = new AllowedArtifactCalls();
  /** Projects with an agent commit waiting for approval on this connection. */
  readonly #pendingCommits = new Set<string>();
  /** Aborts pending project-memory approvals when the connection ends. */
  readonly #memoryAbort = new AbortController();
  /** Saved memories this connection's `recall` answers named, per run (KOBE-399). */
  readonly #recalled = new RecalledItems();
  readonly #deniedBuckets: DeniedEventBuckets;
  readonly #delivery: CommandDelivery;
  /** Every tool frame kind's spec, run only through `#gate` (KOBE-706). */
  readonly #toolFrames: ToolFrameSpecs;
  readonly #gate: ToolFrameGate;
  readonly #checks: RunChecks;
  readonly #port: ConnectionPort;
  readonly #policy: PolicyCheckPort;
  /** `notebook.output` frames of this connection's running executions (KOBE-464). */
  readonly #notebookOutputs: NotebookIntake;
  #state: State = "hello";
  #lastInbound = Date.now();
  readonly #rate: FrameRate;
  #timers: NodeJS.Timeout[] = [];
  #registered = false;
  /** `hello.capabilities` of the agent on this connection (none from older agents). */
  #capabilities: ReadonlySet<string> = new Set();
  /** `workspace.sync_now` asks sent here and not answered yet (KOBE-599). */
  readonly #syncAsks: WorkspaceSyncAsks;
  /** Relayed sandbox spans (KOBE-274): the replica's run state; absent when it does not relay. */
  readonly #traces: TraceIntake | undefined;
  readonly #traceRate: TraceFrameRate | undefined;
  readonly #owner: RunOwner;
  readonly #expiry: SessionExpiry;

  constructor(
    ctx: WireContext,
    socket: WebSocket,
    claims: ConnectionClaims,
    registry: ConnectionRegistry,
  ) {
    this.#ctx = ctx;
    this.#socket = socket;
    this.#registry = registry;
    this.target = {
      teamId: claims.teamId,
      userId: claims.userId,
      ...(claims.evalThreadId === undefined ? {} : { evalThreadId: claims.evalThreadId }),
    };
    this.sandboxId = claims.sandboxId;
    this.#expiry = this.#newExpiry(claims.exp * 1000);
    this.#rate = new FrameRate(ctx.tuning);
    this.#deniedBuckets = new DeniedEventBuckets(ctx.tuning);
    this.#delivery = new CommandDelivery(ctx, this);
    this.#notebookOutputs = new NotebookIntake({
      db: ctx.db,
      teamId: claims.teamId,
      runMaxEvents: ctx.tuning.runMaxEvents,
      log: ctx.log,
      dropped: () => {
        ctx.metrics.notebookOutputsDropped += 1;
      },
    });
    this.#owner = { teamId: claims.teamId, userId: claims.userId, sandboxId: claims.sandboxId };
    this.#traces = ctx.traceRelay?.runs;
    this.#traceRate = this.#traces
      ? new TraceFrameRate(this.#traces.tuning, ctx.metrics)
      : undefined;
    this.#port = this.#newPort();
    this.#syncAsks = new WorkspaceSyncAsks(this.#port);
    this.#checks = new RunChecks({
      leases: this.#leases.runs,
      threads: this.#leases.threads,
      recentlyEnded: this.#leases.recentlyEnded,
      metrics: ctx.metrics,
      sandboxId: this.sandboxId,
      log: this.log,
      sendError: (code, message, ref) => this.sendError(code, message, ref),
      violate: (violation, frameType) => this.#violate(violation, frameType),
    });
    this.#gate = this.#newGate();
    this.#policy = this.#policyPort();
    this.#toolFrames = this.#newToolFrames();
  }

  #newExpiry(expiresAtMs: number): SessionExpiry {
    const host = {
      verifyToken: this.#ctx.verifyToken,
      sandboxId: this.sandboxId,
      target: this.target,
      graceMs: this.#ctx.tuning.tokenExpiryGraceMs,
      log: this.log,
      close: (reason: "unauthorized", message: string) => this.close(reason, message),
      revalidate: () => this.revalidate(),
    };
    return new SessionExpiry(host, expiresAtMs);
  }

  /** The tool-frame gate over this connection's capabilities, leases and allowed calls. */
  #newGate(): ToolFrameGate {
    const tuning = this.#ctx.tuning;
    return {
      hasCapability: (name) => this.hasCapability(name),
      checkToolRun: (runId, threadId, frameType) =>
        this.#checks.toolRun(runId, threadId, frameType),
      allowance: this.#allowedArtifacts,
      get maxInFlight() {
        return tuning.maxPendingArtifactPuts;
      },
    };
  }

  #newToolFrames(): ToolFrameSpecs {
    return toolFrameSpecs({
      port: this.#port,
      inFlight: {
        artifacts: { count: 0 },
        fileShares: { count: 0 },
        memory: { count: 0 },
        skillDrafts: { count: 0 },
      },
      allowed: this.#allowedArtifacts,
      recalled: this.#recalled,
      pendingCommits: this.#pendingCommits,
      signal: this.#memoryAbort.signal,
      notebookExecute: (execute, timeoutMs) => this.#delivery.notebookExecute(execute, timeoutMs),
    });
  }

  /** The narrow view frame handlers get (send, identity, logger, context). */
  #newPort(): ConnectionPort {
    return {
      ctx: this.#ctx,
      target: this.target,
      sandboxId: this.sandboxId,
      connectionId: this.id,
      log: this.log,
      send: (frame) => this.send(frame),
    };
  }

  get ready(): boolean {
    return this.#state === "ready";
  }

  get log() {
    return this.#ctx.log.child({ connection_id: this.id, team_id: this.target.teamId });
  }

  start(): void {
    this.#ctx.metrics.connectionsOpened += 1;
    this.#socket.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    this.#socket.on("close", () => this.#teardown());
    this.#socket.on("error", (err) => this.log.debug({ err: err.message }, "sandbox socket error"));
    this.#later(this.#ctx.tuning.helloTimeoutMs, () => {
      if (this.#state === "hello" || this.#state === "starting")
        this.close("hello_timeout", "no hello");
    });
  }

  // ------------------------------------------------------------------ sending

  send(frame: ServerToSandboxFrame): boolean {
    if (this.#state === "closed" || this.#socket.readyState !== 1) return false;
    this.#socket.send(JSON.stringify(frame));
    if (this.#socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close("internal", "sandbox is not reading");
      return false;
    }
    return true;
  }

  sendError(code: SandboxErrorCode, message: string, ref?: string): void {
    this.send({
      v: 1,
      type: "error",
      code,
      message: message.slice(0, 2000),
      ...(ref === undefined ? {} : { ref: ref.slice(0, 256) }),
    });
  }

  close(reason: SandboxCloseReason | "internal", message: string): void {
    if (this.#state === "closed") return;
    const code = reason === "internal" ? 1011 : SANDBOX_CLOSE_CODES[reason];
    this.log.info({ reason }, "closing sandbox connection");
    try {
      this.#socket.close(code, message.slice(0, 120));
    } catch {
      this.#socket.terminate();
    }
    const kill = setTimeout(() => this.#socket.terminate(), 5_000);
    kill.unref();
    this.#teardown();
  }

  pokeCommands(): void {
    this.#delivery.poke();
  }

  /**
   * Refresh in the Files panel (KOBE-599): ask the agent to push now. The answer
   * (`workspace.synced`) goes back to the requester as a bus hint; an agent that cannot (older, not
   * ready, too many asks in flight) is answered `unsynced` at once, so the requester lists without
   * waiting.
   */
  workspaceSyncNow(requestId: string): void {
    const ready = this.#state === "ready" && this.hasCapability(CAPABILITY_WORKSPACE_SYNC_NOW);
    this.#syncAsks.ask(requestId, ready);
  }

  workspaceMoved(): void {
    if (this.#state !== "ready" || !this.hasCapability(CAPABILITY_WORKSPACE_MOVES)) return;
    this.send({ v: 1, type: "workspace.moved" });
  }

  replaced(): void {
    this.close("replaced", "replaced by a newer connection");
  }

  // ------------------------------------------------------------------ leases (used by delivery)

  hasLiveLease(runId: string): boolean {
    return this.#leases.isLive(runId);
  }

  hasLease(runId: string): boolean {
    return this.#leases.runs.has(runId);
  }

  liveMessageRuns(threadId: string): readonly string[] {
    return this.#leases.liveMessageRuns(threadId);
  }

  hasCapability(name: string): boolean {
    return this.#capabilities.has(name);
  }

  leaseThread(threadId: string): void {
    this.#leases.threads.add(threadId);
  }

  /** A run.start is about to be delivered here: the run (and its thread) are leased to us. */
  leaseRun(
    runId: string,
    threadId: string,
    cursor: number,
    compaction = false,
    startedAt: Date | null = null,
  ): void {
    if (this.#leases.isLive(runId)) return;
    this.#traces?.track(runId, threadId, startedAt, this.#owner);
    this.#leases.add(runId, {
      threadId,
      ended: false,
      compaction,
      ingest: this.#newIngest(runId, threadId, cursor, runLatency(runId, cursor > 0, compaction)),
    });
  }

  /** The run's start carried a trace context naming `commandSpanId` (KOBE-274). */
  traceStarted(runId: string, commandSpanId: string): void {
    this.#traces?.traced(runId, commandSpanId);
  }

  /** The run ended (here or elsewhere): late frames get `run_not_active`. */
  endLease(runId: string): void {
    const lease = this.#leases.end(runId);
    if (!lease) return;
    this.#traces?.ended(runId);
    lease.ingest.close();
    this.#deniedBuckets.forget(runId);
    this.#leases.prune();
  }

  #newIngest(runId: string, threadId: string, cursor: number, latency: RunLatency): RunIngest {
    return newRunIngest(
      {
        port: this.#port,
        delivery: this.#delivery,
        sendError: (code, message, ref) => this.sendError(code, message, ref),
        endLease: (run) => this.endLease(run),
        close: (reason, message) => this.close(reason, message),
        limitExceeded: (run, thread, limit) => void this.#limitExceeded(run, thread, limit),
      },
      runId,
      threadId,
      cursor,
      latency,
    );
  }

  // ------------------------------------------------------------------ inbound

  #overLimit(limit: SandboxLimit, message: string): void {
    this.#ctx.auditLimit(this.target, this.sandboxId, limit);
    this.close("protocol_error", message);
  }

  #onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.#state === "closed") return;
    this.#lastInbound = Date.now();
    this.#ctx.metrics.framesIn += 1;
    const raw = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
    const limit = this.#rate.charge(raw.length);
    if (limit) {
      this.#overLimit(limit, limit === "byte_rate" ? "byte rate exceeded" : "frame rate exceeded");
      return;
    }
    if (isBinary) {
      this.#ctx.metrics.malformedFrames += 1;
      this.sendError("malformed_frame", "binary frames are not part of the protocol");
      return;
    }
    if (!frameSizeOk(raw, this.#state === "ready", this.#ctx.tuning.frameMaxBytes)) {
      this.#overLimit("frame_size", "frame too large for its type");
      return;
    }
    const text = raw.toString("utf8");
    const decoded = decodeSandboxFrame(text);
    if (!decoded.ok) {
      this.#ctx.metrics.malformedFrames += 1;
      this.sendError(decoded.code, decoded.message);
      return;
    }
    const frame = decoded.frame;
    if (frame.type === "ping") {
      this.send({ v: 1, type: "pong", nonce: frame.nonce });
      return;
    }
    if (frame.type === "pong") return;
    if (this.#state === "hello") {
      if (frame.type !== "hello") {
        this.close("protocol_error", "hello expected");
        return;
      }
      this.#state = "starting";
      this.#hello(frame).catch((err: unknown) => {
        this.log.error({ err }, "sandbox hello failed");
        this.close("internal", "hello failed");
      });
      return;
    }
    if (this.#state !== "ready" || frame.type === "hello") {
      this.close("protocol_error", "unexpected frame");
      return;
    }
    this.#dispatch(frame, Buffer.byteLength(text, "utf8"));
  }

  #dispatch(frame: SandboxToServerFrame, bytes: number): void {
    // Tool frames run only through the gate (KOBE-706); the switch below cannot name one.
    if (isToolFrame(frame, this.#toolFrames)) {
      runToolFrame(this.#gate, this.#toolFrames, frame);
      return;
    }
    switch (frame.type) {
      case "pi.event":
        this.#onPiEvent(frame, bytes);
        return;
      case "policy.check":
        onPolicyCheck(this.#policy, frame);
        return;
      case "workspace.conflict":
        this.#onWorkspaceConflict(frame);
        return;
      case "workspace.synced":
        this.#syncAsks.synced(frame.request_id, frame.ok);
        return;
      case "notebook.output":
        onNotebookOutput(
          {
            delivery: this.#delivery,
            intake: this.#notebookOutputs,
            metrics: this.#ctx.metrics,
            violate: (violation, frameType) => this.#violate(violation, frameType),
          },
          frame,
          bytes,
        );
        return;
      case "web_search.query":
        onLegacyWebSearch(this.#port, frame);
        return;
      case "trace.spans":
        onTraceSpans(
          {
            traces: this.#traces,
            rate: this.#traceRate,
            announced: this.#capabilities.has(CAPABILITY_TRACE_SPANS),
            metrics: this.#ctx.metrics,
            owner: this.#owner,
            leaseThread: (runId) => this.#leases.runs.get(runId)?.threadId,
            violate: (violation, frameType) => this.#violate(violation, frameType),
          },
          frame,
        );
        return;
      case "session.renew":
        this.#expiry.renew(frame.token, this.#capabilities.has(CAPABILITY_SESSION_RENEW));
        return;
      case "command.result":
        onCommandResult(this.#results(), frame);
        return;
      case "thread.compact_result":
        onCompactResult(this.#results(), frame);
        return;
      case "thread.branch_summary_result":
        onBranchSummaryResult(this.#results(), frame);
        return;
      case "pi.ui_request":
        onUiRequest(
          {
            ui: this.#ctx.ui,
            target: this.target,
            seen: this.#uiSeen,
            log: this.#port.log,
            leased: (f) =>
              f.run_id === undefined
                ? this.#checks.thread(f.thread_id, "pi.ui_request")
                : this.#checks.run(f.run_id, f.thread_id, "pi.ui_request") === "ok",
            send: (out) => this.send(out),
          },
          frame,
        );
        return;
      case "pi.exited":
        this.#onPiExited(frame.thread_id, frame.exit_code, frame.signal);
        return;
      case "error":
        this.log.warn({ code: frame.code, ref: frame.ref }, "sandbox reported an error");
        return;
      default:
        return;
    }
  }

  violate(violation: LeaseViolation, frameType: string): void {
    this.#violate(violation, frameType);
  }

  #violate(violation: LeaseViolation, frameType: string): void {
    this.#ctx.metrics.leaseViolations += 1;
    this.log.warn(
      { violation, frame_type: frameType, sandbox_id: this.sandboxId },
      "lease violation",
    );
    const code: SandboxErrorCode =
      violation === "unknown_thread" ? "unknown_thread" : "unknown_run";
    this.sendError(code, `not leased to this connection (${violation})`, frameType);
    this.#ctx.auditViolation(this.target, this.sandboxId, violation, frameType);
    this.close("lease_violation", violation);
  }

  #onPiEvent(frame: PiEventFrame, bytes: number): void {
    const check = this.#checks.run(frame.run_id, frame.thread_id, "pi.event");
    if (check === "violation") return;
    if (check === "ended") {
      // Not executed; acknowledged so the agent can forget the run (benign race after Stop).
      this.send({ v: 1, type: "ack", run_id: frame.run_id, seq: frame.seq });
      return;
    }
    this.#leases.runs.get(frame.run_id)?.ingest.push(frame, bytes);
  }

  /** What `frames/policy.ts` gets for `policy.check` frames. */
  #policyPort(): PolicyCheckPort {
    return {
      ctx: this.#ctx,
      target: this.target,
      connectionId: this.id,
      pending: this.#policyPending,
      answered: this.#policyAnswered,
      allowed: this.#allowedArtifacts,
      traces: this.#traces,
      hasCapability: (name) => this.hasCapability(name),
      checkToolRun: (runId, threadId, type) => this.#checks.toolRun(runId, threadId, type),
      leaseEnded: (runId) => this.#leases.runs.get(runId)?.ended,
      takeDeniedToken: (runId) => this.#deniedBuckets.take(runId),
      send: (frame) => this.send(frame),
    };
  }

  /** `workspace.conflict` (KOBE-492): checks and record in `sync-conflict.ts`. */
  #onWorkspaceConflict(frame: WorkspaceConflictFrame): void {
    onWorkspaceConflict(
      {
        db: this.#ctx.db,
        target: this.target,
        log: this.log,
        hasCapability: this.hasCapability(CAPABILITY_SYNC_CONFLICTS),
        rate: this.#conflictRate,
        activeRun: (threadId) => this.#leases.liveMessageRuns(threadId)[0],
        send: (out) => this.send(out),
      },
      frame,
    );
  }

  /** What the command-result handlers (`frames/results.ts`) get. */
  #results(): CommandResultPort {
    return {
      delivery: this.#delivery,
      notebookOutputs: this.#notebookOutputs,
      violate: (violation, frameType) => this.#violate(violation, frameType),
    };
  }

  #onPiExited(threadId: string, exitCode: number | null, signal: string | null): void {
    if (!this.#checks.thread(threadId, "pi.exited")) return;
    this.log.warn({ thread_id: threadId, exit_code: exitCode, signal }, "Pi exited");
    for (const [runId, lease] of this.#leases.runs) {
      if (lease.threadId !== threadId || lease.ended) continue;
      this.endLease(runId);
      void this.interrupt(runId, "pi_exited");
    }
    this.#delivery.forgetSession(threadId);
  }

  /** A storage cap: the run fails (terminal event within the cap) and Pi is stopped. */
  async #limitExceeded(
    runId: string,
    threadId: string,
    limit: "run_events" | "run_bytes" | "thread_entries",
  ): Promise<void> {
    this.endLease(runId);
    this.log.warn({ run_id: runId, limit }, "sandbox storage limit reached; failing the run");
    this.#ctx.auditLimit(this.target, this.sandboxId, limit, runId);
    this.#delivery.stopRun(runId, threadId);
    await failOversizedRun(this.#ctx, this.target, runId, threadId, limit, this.log);
  }

  /** Interrupts an active run (D14: never retried automatically). */
  interrupt(runId: string, cause: InterruptCause): Promise<void> {
    return interruptRun(this.#ctx, this.target, runId, cause, this.log);
  }

  // ------------------------------------------------------------------ hello

  async #hello(hello: HelloFrame): Promise<void> {
    const ctx = this.#ctx;
    if (hello.sandbox_id !== this.sandboxId) {
      ctx.auditTokenRejected({ sandboxId: this.sandboxId, ...this.target }, "sandbox_mismatch");
      this.close("unauthorized", "sandbox_id does not match the token");
      return;
    }
    // Logs a warning for a previous minor (PI_PREVIOUS_MINORS; team_id is on this.log).
    if (!admitPiVersion(hello.pi_version, this.log, this.sandboxId)) {
      this.close("unsupported_version", `Pi ${hello.pi_version.slice(0, 32)} is not supported`);
      return;
    }
    this.#capabilities = new Set(hello.capabilities ?? []);
    const current = await this.#registry.register(this);
    this.#registered = true;
    if ((this.#state as State) === "closed") {
      // Torn down while registering: nothing else will mark the row closed.
      await this.#registry.unregister(this);
      return;
    }
    if (current === "hibernating") {
      this.close("hibernating", "sandbox is hibernated");
      return;
    }
    if (current === "replaced") {
      this.close("replaced", "a newer connection of this sandbox registered first");
      return;
    }
    const { listed, lost, orphans } = await helloRuns(this.#port, hello);
    for (const run of listed) this.#resume(run);
    // Runs the sandbox no longer has (Pi or agent restarted, volume lost): interrupted, never
    // resumed (D14). Runs it offers that we don't list are aborted by the agent.
    for (const run of lost) {
      // The agent may still send a frame of it (an abort in flight): dropped, not a violation.
      this.#leases.recentlyEnded.add(run.runId, run.threadId);
      await this.interrupt(run.runId, "not_resumed");
    }
    await reconcileOrphans(ctx, this.target, orphans, new Set(listed.map((r) => r.runId)));
    if ((this.#state as State) === "closed") return;
    this.#state = "ready";
    this.#ackHello(listed, lost.length);
  }

  /** A run listed in the hello is leased again here, from its durable cursor. */
  #resume(run: LeasedRun): void {
    this.#leases.add(run.runId, {
      threadId: run.threadId,
      ended: false,
      compaction: false, // a compaction is never kept (helloRuns)
      ingest: this.#newIngest(
        run.runId,
        run.threadId,
        run.sandboxSeq,
        runLatency(run.runId, true, false),
      ),
    });
    // A resumed run keeps the trace context its agent got on the old connection (KOBE-274):
    // on this replica its state (command spans, cap, seen-set) is still known; on another one
    // it starts afresh, marked traced (harmless: same run, same team).
    const knownTraced = this.#traces?.isTraced(run.runId) === true;
    this.#traces?.track(run.runId, run.threadId, run.startedAt, this.#owner);
    if (!knownTraced && this.#capabilities.has(CAPABILITY_TRACE_SPANS)) {
      this.#traces?.traced(run.runId);
    }
  }

  #ackHello(listed: readonly LeasedRun[], interrupted: number): void {
    const ctx = this.#ctx;
    this.send({
      v: 1,
      type: "hello.ack",
      connection_id: this.id,
      server_time: new Date().toISOString(),
      heartbeat_interval_ms: ctx.tuning.heartbeatIntervalMs,
      runs: listed.map((r) => ({
        run_id: r.runId,
        thread_id: r.threadId,
        durable_seq: r.sandboxSeq,
      })),
    });
    this.log.info(
      { sandbox_id: this.sandboxId, resumed: listed.length, interrupted },
      "sandbox connected",
    );
    recordHelloTiming(ctx, this.target, Date.now(), this.log);
    this.#startTimers();
    this.#delivery.poke();
  }

  // ------------------------------------------------------------------ timers and teardown

  #later(ms: number, fn: () => void): void {
    const t = setTimeout(fn, ms);
    t.unref();
    this.#timers.push(t);
  }

  #every(ms: number, fn: () => void): void {
    const t = setInterval(fn, ms);
    t.unref();
    this.#timers.push(t);
  }

  #startTimers(): void {
    const { tuning } = this.#ctx;
    this.#every(tuning.heartbeatIntervalMs, () => {
      if (Date.now() - this.#lastInbound > tuning.heartbeatTimeoutMs) {
        this.close("heartbeat_timeout", "no frames from the sandbox");
        return;
      }
      this.send({ v: 1, type: "ping", nonce: randomUUID() });
    });
    this.#every(tuning.touchMs, () => {
      this.#registry
        .touch(this)
        .then((current) => {
          if (!current) this.close("replaced", "replaced by a newer connection");
        })
        .catch((err: unknown) => this.log.warn({ err }, "connection heartbeat write failed"));
    });
    this.#every(tuning.revalidateMs, () => this.revalidate());
    this.#expiry.arm();
  }

  /** Re-checks the sandbox's liveness and its user's account and membership; closes if gone. */
  revalidate(): void {
    void (async () => {
      const claims = { sandboxId: this.sandboxId, ...this.target };
      if (!(await this.#ctx.liveness.isLive(claims)))
        this.close("sandbox_destroyed", "sandbox is gone");
      else if (!(await this.#ctx.principalAllowed(this.target)))
        this.close("unauthorized", "access revoked");
    })().catch((err: unknown) => this.log.warn({ err }, "connection revalidation failed"));
  }

  #teardown(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#ctx.metrics.connectionsClosed += 1;
    for (const t of this.#timers) clearTimeout(t);
    this.#expiry.clear();
    this.#timers = [];
    for (const abort of this.#policyPending.values()) abort.abort();
    this.#policyPending.clear();
    // Waiting Refreshes list now instead of at their timeout.
    this.#syncAsks.close();
    this.#memoryAbort.abort();
    for (const lease of this.#leases.runs.values()) lease.ingest.close();
    this.#delivery.close();
    if (this.#registered) {
      // Runs stay leased: a reconnect within the grace period resumes them; the sweep
      // interrupts them otherwise (D14).
      this.#registry
        .unregister(this)
        .catch((err: unknown) => this.log.warn({ err }, "could not mark the connection closed"));
    }
  }
}

export type { IssuedCommand };
