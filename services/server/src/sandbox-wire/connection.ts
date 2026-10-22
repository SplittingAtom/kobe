import { randomUUID } from "node:crypto";
import {
  CAPABILITY_ARTIFACTS,
  CAPABILITY_FILE_EDITS,
  CAPABILITY_NOTEBOOKS,
  CAPABILITY_FILES,
  CAPABILITY_MEMORY,
  CAPABILITY_PROJECTS,
  CAPABILITY_SKILL_DRAFTS,
  CAPABILITY_TRACE_SPANS,
  CAPABILITY_WEB_SEARCH,
  CAPABILITY_WORKSPACE_MOVES,
  builtinToolDescriptor,
  PI_PINNED_VERSION,
  SANDBOX_CLOSE_CODES,
  decodeSandboxFrame,
  type ArtifactPutFrame,
  type CommandResultFrame,
  type ErrorInfo,
  type FileShareFrame,
  type HelloFrame,
  type PiEventFrame,
  type PolicyCheckFrame,
  type SandboxCloseReason,
  type SandboxErrorCode,
  type SandboxToServerFrame,
  type FileEditProposeFrame,
  type FileOpenFrame,
  type NotebookOutputFrame,
  type NotebookRunFrame,
  type SkillDraftSaveFrame,
  type TraceSpansFrame,
  type WebSearchQueryFrame,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { withAppendTx } from "../event-stream/append.js";
import type WebSocket from "ws";
import { completeCommand, orphanedDeliveries } from "./commands.js";
import { UI_DEDUPE_MAX } from "./constants.js";
import type { LeaseViolation, SandboxLimit, WireContext } from "./context.js";
import { CommandDelivery, type IssuedCommand } from "./delivery.js";
import { RunIngest } from "./ingest.js";
import { AllowedArtifactCalls } from "../artifacts/allowed.js";
import { putArtifact } from "../artifacts/put.js";
import { shareFile } from "../files/share.js";
import {
  proposeProjectFile,
  type ProposeRefusal,
  type ProposeReply,
} from "../projects/proposals.js";
import { putMemory, readMemory, type MemoryRefusal, type MemoryReply } from "../memory/agent.js";
import { decidePolicyCheck, denyFrame } from "./policy-check.js";
import type { ConnectionRegistry, RegisteredConnection } from "./registry.js";
import {
  activeLeasedRuns,
  endRunInTx,
  isActiveMessageRun,
  type InterruptCause,
} from "./run-state.js";
import { onFileEditPropose } from "./file-edit-propose.js";
import { onFileOpen } from "./file-open.js";
import { NotebookIntake } from "./notebook-intake.js";
import { onNotebookRun } from "./notebook-run.js";
import { onSkillDraftSave } from "./skill-draft-save.js";
import { createRunTranslator } from "./translate.js";
import { TraceFrameRate, type RunOwner, type TraceIntake } from "./trace-intake.js";
import type { CommandOutcome, SandboxTarget } from "./types.js";

export interface ConnectionClaims {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
  /** A skill eval's ephemeral sandbox (KOBE-325): its eval thread, from the signed token. */
  readonly evalThreadId?: string;
  /** Session token `exp` (seconds since the epoch). */
  readonly exp: number;
}

interface Lease {
  readonly threadId: string;
  readonly ingest: RunIngest;
  ended: boolean;
  /** A compaction run (KOBE-213): Pi's compact uses no tools, so no tool frame may name it. */
  readonly compaction: boolean;
}

type State = "hello" | "starting" | "ready" | "closed";

const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const POLICY_ANSWERED_MAX = 4_096;
/** `{"v":1,"type":"<type>"` at the start of a frame (whitespace tolerated). */
const FRAME_PREFIX = /^\s*\{\s*"v"\s*:\s*1\s*,\s*"type"\s*:\s*"([a-z._]{1,32})"/;
/** Ended leases kept to answer late frames with `run_not_active`; older ones are forgotten. */
const ENDED_LEASES_MAX = 256;

function remember(set: Set<string>, value: string, max: number): void {
  set.add(value);
  if (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

/** `1.0.x` only (contract: the server refuses anything else with `unsupported_version`). */
export function supportedPiVersion(version: string): boolean {
  const pinned = PI_PINNED_VERSION.split(".").slice(0, 2).join(".");
  return new RegExp(`^${pinned.replace(".", "\\.")}\\.\\d+$`).test(version);
}

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
  readonly #leases = new Map<string, Lease>();
  readonly #threads = new Set<string>();
  readonly #uiSeen = new Set<string>();
  readonly #policyPending = new Map<string, AbortController>();
  readonly #policyAnswered = new Set<string>();
  /** Artifact tool calls this connection's policy checks allowed (D-3 of KOBE-55). */
  readonly #allowedArtifacts = new AllowedArtifactCalls();
  #artifactPuts = 0;
  #fileShares = 0;
  #webSearches = 0;
  #memoryOps = 0;
  #projectProposals = 0;
  readonly #skillDraftSaves = { count: 0 };
  /** Aborts pending project-memory approvals when the connection ends. */
  readonly #memoryAbort = new AbortController();
  readonly #deniedBuckets = new Map<string, { tokens: number; at: number }>();
  readonly #delivery: CommandDelivery;
  /** `notebook.output` frames of this connection's running executions (KOBE-464). */
  readonly #notebookOutputs: NotebookIntake;
  #state: State = "hello";
  #lastInbound = Date.now();
  #tokens: number;
  #byteTokens: number;
  #tokensAt = Date.now();
  #timers: NodeJS.Timeout[] = [];
  #registered = false;
  /** `hello.capabilities` of the agent on this connection (none from older agents). */
  #capabilities: ReadonlySet<string> = new Set();
  /** Relayed sandbox spans (KOBE-274): the replica's run state; absent when it does not relay. */
  readonly #traces: TraceIntake | undefined;
  readonly #traceRate: TraceFrameRate | undefined;
  readonly #owner: RunOwner;
  readonly #tokenExpiresAt: number;

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
    this.#tokenExpiresAt = claims.exp * 1000;
    this.#tokens = ctx.tuning.frameBurst;
    this.#byteTokens = ctx.tuning.byteBurst;
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

  workspaceMoved(): void {
    if (this.#state !== "ready" || !this.hasCapability(CAPABILITY_WORKSPACE_MOVES)) return;
    this.send({ v: 1, type: "workspace.moved" });
  }

  replaced(): void {
    this.close("replaced", "replaced by a newer connection");
  }

  // ------------------------------------------------------------------ leases (used by delivery)

  hasLiveLease(runId: string): boolean {
    const lease = this.#leases.get(runId);
    return lease !== undefined && !lease.ended;
  }

  hasLease(runId: string): boolean {
    return this.#leases.has(runId);
  }

  hasCapability(name: string): boolean {
    return this.#capabilities.has(name);
  }

  leaseThread(threadId: string): void {
    this.#threads.add(threadId);
  }

  /** A run.start is about to be delivered here: the run (and its thread) are leased to us. */
  leaseRun(
    runId: string,
    threadId: string,
    cursor: number,
    compaction = false,
    startedAt: Date | null = null,
  ): void {
    const existing = this.#leases.get(runId);
    if (existing && !existing.ended) return;
    this.#threads.add(threadId);
    this.#traces?.track(runId, threadId, startedAt, this.#owner);
    this.#leases.set(runId, {
      threadId,
      ended: false,
      compaction,
      ingest: this.#newIngest(runId, threadId, cursor),
    });
  }

  /** The run's start carried a trace context naming `commandSpanId` (KOBE-274). */
  traceStarted(runId: string, commandSpanId: string): void {
    this.#traces?.traced(runId, commandSpanId);
  }

  /** The run ended (here or elsewhere): late frames get `run_not_active`. */
  endLease(runId: string): void {
    const lease = this.#leases.get(runId);
    if (!lease) return;
    lease.ended = true;
    this.#traces?.ended(runId);
    lease.ingest.close();
    this.#deniedBuckets.delete(runId);
    const ended = [...this.#leases].filter(([, l]) => l.ended);
    for (const [id] of ended.slice(0, Math.max(0, ended.length - ENDED_LEASES_MAX))) {
      this.#leases.delete(id);
    }
  }

  #newIngest(runId: string, threadId: string, cursor: number): RunIngest {
    const ctx = this.#ctx;
    return new RunIngest({
      db: ctx.db,
      teamId: this.target.teamId,
      runId,
      threadId,
      cursor,
      tuning: ctx.tuning,
      serverCalls: ctx.serverCalls,
      createTranslator: () =>
        createRunTranslator({
          teamId: this.target.teamId,
          registry: ctx.tools,
          onDropped: (dropped) => {
            ctx.metrics.eventsDropped += 1;
            this.log.warn({ run_id: runId, ...dropped }, "dropped a translated event");
          },
        }),
      host: {
        metrics: ctx.metrics,
        log: this.log,
        sendAck: (run, seq) => this.send({ v: 1, type: "ack", run_id: run, seq }),
        sendResend: (run, from) => this.send({ v: 1, type: "resend", run_id: run, from_seq: from }),
        sendError: (code, message, ref) => this.sendError(code, message, ref),
        fetchNewEntries: (thread) => this.#delivery.fetchNewEntries(thread),
        runEnded: (run, status) => {
          this.endLease(run);
          if (status === undefined) return;
          if (status === "completed") ctx.metrics.runsCompleted += 1;
          ctx.runEnded({ teamId: this.target.teamId, runId: run, threadId, status });
        },
        failed: () => this.close("internal", "events could not be stored"),
        needsSync: (thread) => this.#delivery.forgetSession(thread),
        limitExceeded: (run, limit) => void this.#limitExceeded(run, threadId, limit),
      },
    });
  }

  // ------------------------------------------------------------------ inbound

  /** Frame and byte token buckets, charged before anything is decoded. */
  #rateOk(bytes: number): SandboxLimit | undefined {
    const { frameRatePerSec, frameBurst, byteRatePerSec, byteBurst } = this.#ctx.tuning;
    const now = Date.now();
    const elapsed = (now - this.#tokensAt) / 1000;
    this.#tokensAt = now;
    this.#tokens = Math.min(frameBurst, this.#tokens + elapsed * frameRatePerSec);
    this.#byteTokens = Math.min(byteBurst, this.#byteTokens + elapsed * byteRatePerSec);
    if (this.#tokens < 1) return "frame_rate";
    if (this.#byteTokens < bytes) return "byte_rate";
    this.#tokens -= 1;
    this.#byteTokens -= bytes;
    return undefined;
  }

  /**
   * Size cap by frame type, read from the raw prefix (KOBE-23 writes `{"v":1,"type":…` first):
   * only `pi.event` / `command.result` may use the full 4 MiB, `policy.check` a smaller cap, and
   * any other or unreadable type must be small — so a hostile frame is refused before parsing.
   */
  #sizeOk(raw: Buffer): boolean {
    const max = this.#ctx.tuning.frameMaxBytes;
    if (raw.length <= max.small) return true;
    if (this.#state !== "ready") return false;
    const type = FRAME_PREFIX.exec(raw.subarray(0, 64).toString("latin1"))?.[1];
    if (type === "pi.event" || type === "command.result") return raw.length <= max.bulk;
    if (type === "policy.check") return raw.length <= max.policyCheck;
    if (type === "artifact.put") return raw.length <= max.artifactPut;
    if (type === "thread.compact_result") return raw.length <= max.compactResult;
    if (type === "notebook.run") return raw.length <= max.notebookRun;
    return false;
  }

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
    const limit = this.#rateOk(raw.length);
    if (limit) {
      this.#overLimit(limit, limit === "byte_rate" ? "byte rate exceeded" : "frame rate exceeded");
      return;
    }
    if (isBinary) {
      this.#ctx.metrics.malformedFrames += 1;
      this.sendError("malformed_frame", "binary frames are not part of the protocol");
      return;
    }
    if (!this.#sizeOk(raw)) {
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
    switch (frame.type) {
      case "pi.event":
        this.#onPiEvent(frame, bytes);
        return;
      case "policy.check":
        this.#onPolicyCheck(frame);
        return;
      case "artifact.put":
        this.#onArtifactPut(frame);
        return;
      case "file.share":
        this.#onFileShare(frame);
        return;
      case "project.file_propose":
        this.#onProjectFilePropose(frame);
        return;
      case "skill.draft_save":
        this.#onSkillDraftSave(frame);
        return;
      case "file.edit_propose":
        this.#onFileEditPropose(frame);
        return;
      case "file.open":
        this.#onFileOpen(frame);
        return;
      case "notebook.output":
        this.#onNotebookOutput(frame, bytes);
        return;
      case "notebook.run":
        this.#onNotebookRun(frame);
        return;
      case "memory.put":
        this.#onMemoryPut(frame);
        return;
      case "memory.read":
        this.#onMemoryRead(frame);
        return;
      case "web_search.query":
        this.#onWebSearch(frame);
        return;
      case "trace.spans":
        this.#onTraceSpans(frame);
        return;
      case "command.result":
        this.#onCommandResult(frame);
        return;
      case "thread.compact_result":
        this.#onCompactResult(frame);
        return;
      case "pi.ui_request":
        this.#onUiRequest(frame);
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

  /** ok | ended (late frame of a run of this connection) | violation (already handled). */
  /**
   * `#checkRun` for frames a tool sends (policy checks, artifacts, files, memory, proposals, web
   * search): a compaction run (KOBE-213) makes no tool calls, so one naming it fails closed, as if
   * the run had ended, and is logged as a security event.
   */
  #checkToolRun(runId: string, threadId: string, frameType: string): "ok" | "ended" | "violation" {
    const check = this.#checkRun(runId, threadId, frameType);
    if (check !== "ok" || this.#leases.get(runId)?.compaction !== true) return check;
    this.log.warn(
      { run_id: runId, frame_type: frameType, sandbox_id: this.sandboxId, security: true },
      "tool frame for a compaction run refused",
    );
    this.sendError("run_not_active", "a compaction run makes no tool calls", frameType);
    return "ended";
  }

  #checkRun(runId: string, threadId: string, frameType: string): "ok" | "ended" | "violation" {
    const lease = this.#leases.get(runId);
    if (!lease) {
      this.#violate("unknown_run", frameType);
      return "violation";
    }
    if (lease.threadId !== threadId) {
      this.#violate("unknown_thread", frameType);
      return "violation";
    }
    if (lease.ended) {
      this.#ctx.metrics.lateFrames += 1;
      this.sendError("run_not_active", "the run has ended", frameType);
      return "ended";
    }
    return "ok";
  }

  #checkThread(threadId: string, frameType: string): boolean {
    if (this.#threads.has(threadId)) return true;
    this.#violate("unknown_thread", frameType);
    return false;
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
    const check = this.#checkRun(frame.run_id, frame.thread_id, "pi.event");
    if (check === "violation") return;
    if (check === "ended") {
      // Not executed; acknowledged so the agent can forget the run (benign race after Stop).
      this.send({ v: 1, type: "ack", run_id: frame.run_id, seq: frame.seq });
      return;
    }
    this.#leases.get(frame.run_id)?.ingest.push(frame, bytes);
  }

  /**
   * `trace.spans` (KOBE-274): never answered, never closing the connection, except for a run or
   * thread this connection never held (a lease violation like any other frame's). Classified by
   * the decoded type (key order cannot skip the rate); the spans are parsed later, one by one.
   */
  #onTraceSpans(frame: TraceSpansFrame): void {
    const traces = this.#traces;
    if (
      traces === undefined ||
      this.#traceRate === undefined ||
      !this.#capabilities.has(CAPABILITY_TRACE_SPANS)
    ) {
      this.#ctx.metrics.traceFramesDropped += 1;
      return;
    }
    if (!this.#traceRate.admit()) return;
    const lease = this.#leases.get(frame.run_id);
    if (lease === undefined) {
      // Note: a late frame for a run whose lease the ended-lease count cap evicted AND whose 30 s
      // trace grace passed is a violation; that needs 256 ended runs on one connection meanwhile.
      if (traces.recentlyEnded(frame.run_id, frame.thread_id, this.#owner)) {
        traces.dropFrame(frame.run_id, frame.spans.length);
      } else {
        this.#violate("unknown_run", "trace.spans");
      }
      return;
    }
    if (lease.threadId !== frame.thread_id) {
      this.#violate("unknown_thread", "trace.spans");
      return;
    }
    traces.accept(frame, this.#owner);
  }

  #onPolicyCheck(frame: PolicyCheckFrame): void {
    const check = this.#checkToolRun(frame.run_id, frame.thread_id, "policy.check");
    if (check === "violation") return;
    if (check === "ended") {
      this.send(
        denyFrame(frame, [], "The run has ended, so the tool call was denied.", "run_not_active"),
      );
      return;
    }
    if (this.#policyPending.size >= this.#ctx.tuning.maxPendingPolicyChecks) {
      this.send(denyFrame(frame, [], "Too many tool calls are waiting for a decision. Try again."));
      return;
    }
    const key = `${frame.run_id}:${frame.request_id}`;
    // One answer per request id, also after it was answered (a replay must not ask twice).
    if (this.#policyPending.has(key) || this.#policyAnswered.has(key)) return;
    const abort = new AbortController();
    this.#policyPending.set(key, abort);
    this.#ctx.metrics.policyChecks += 1;
    void decidePolicyCheck(
      this.#ctx.policy,
      { ...this.target, connectionId: this.id },
      frame,
      abort.signal,
      (pending) =>
        this.send({
          v: 1,
          type: "policy.pending",
          request_id: frame.request_id,
          run_id: frame.run_id,
          tool_call_id: frame.tool_call_id,
          approval_id: pending.approvalId,
          expires_at: pending.expiresAt,
        }),
      () => this.#takeDeniedToken(frame.run_id),
    ).then((result) => {
      this.#policyPending.delete(key);
      remember(this.#policyAnswered, key, POLICY_ANSWERED_MAX);
      // Tool spans get their name from this decision, never from the sandbox (KOBE-274): a denied
      // call's name is model text unless it names a built-in.
      const known = result.decision === "allow" || builtinToolDescriptor(frame.tool) !== undefined;
      this.#traces?.noteToolCall(frame.run_id, frame.tool_call_id, known ? frame.tool : undefined);
      // A run that ended while we decided gets a deny, whatever the decision was.
      const lease = this.#leases.get(frame.run_id);
      if (result.decision === "allow" && lease && !lease.ended) {
        // D-3: the artifact input the server allowed, by hash, before the call reaches the sandbox.
        this.#allowedArtifacts.record(frame.run_id, frame.tool_call_id, frame.tool, frame.input);
      }
      this.send(
        lease?.ended && result.decision === "allow"
          ? denyFrame(
              frame,
              [],
              "The run has ended, so the tool call was denied.",
              "run_not_active",
            )
          : result,
      );
    });
  }

  /**
   * `artifact.put` (KOBE-129, D-3 of KOBE-55). Accepted only if this connection announced the
   * capability, the run is leased here and active, and this tool call was allowed here for this
   * tool with the same canonical input hash; the rest (same team and thread, idempotency) is in
   * `putArtifact`. Every refusal is audited (no content) and answered with `artifact.result`.
   */
  #onArtifactPut(frame: ArtifactPutFrame): void {
    const refuse = (
      reason: Parameters<WireContext["auditArtifactRefused"]>[2]["reason"],
      code: "not_allowed" | "not_found",
      message: string,
    ) => {
      this.#ctx.auditArtifactRefused(this.target, this.sandboxId, {
        reason,
        tool: frame.tool,
        runId: frame.run_id,
        toolCallId: frame.tool_call_id,
      });
      this.send({
        v: 1,
        type: "artifact.result",
        request_id: frame.request_id,
        ok: false,
        error: { code, message },
      });
    };
    if (!this.hasCapability(CAPABILITY_ARTIFACTS)) {
      refuse(
        "capability_missing",
        "not_allowed",
        "This sandbox did not announce artifact support.",
      );
      return;
    }
    const check = this.#checkToolRun(frame.run_id, frame.thread_id, "artifact.put");
    if (check === "violation") return;
    if (check === "ended") {
      refuse("run_not_active", "not_allowed", "The run has ended, so the artifact was not stored.");
      return;
    }
    const verdict = this.#allowedArtifacts.check(
      frame.run_id,
      frame.tool_call_id,
      frame.tool,
      frame.input,
    );
    if (verdict !== "ok") {
      refuse(
        verdict,
        "not_allowed",
        verdict === "input_mismatch"
          ? "The artifact differs from the call that was allowed."
          : "This tool call was not allowed for this tool.",
      );
      return;
    }
    if (this.#artifactPuts >= this.#ctx.tuning.maxPendingArtifactPuts) {
      this.send({
        v: 1,
        type: "artifact.result",
        request_id: frame.request_id,
        ok: false,
        error: {
          code: "storage_failed",
          message: "Too many artifacts are being stored. Try again.",
        },
      });
      return;
    }
    this.#artifactPuts += 1;
    void putArtifact(this.#ctx.artifacts, this.target, frame)
      .catch((err: unknown) => {
        this.log.error({ err }, "artifact.put failed");
        return {
          ok: false,
          code: "storage_failed",
          message: "The artifact could not be stored. Try again.",
        } as const;
      })
      .then((result) => {
        this.#artifactPuts -= 1;
        if (result.ok) {
          this.send({
            v: 1,
            type: "artifact.result",
            request_id: frame.request_id,
            ok: true,
            artifact_id: result.artifactId,
            version: result.version,
          });
          return;
        }
        if ("refusal" in result && result.refusal) {
          this.#ctx.auditArtifactRefused(this.target, this.sandboxId, {
            reason: result.refusal,
            tool: frame.tool,
            runId: frame.run_id,
            toolCallId: frame.tool_call_id,
          });
        }
        this.send({
          v: 1,
          type: "artifact.result",
          request_id: frame.request_id,
          ok: false,
          error: { code: result.code, message: result.message },
        });
      });
  }

  /**
   * `file.share` (KOBE-150). Accepted only if this connection announced `files`, the run is
   * leased here and active, and this `share_file` call was allowed here with the same canonical
   * input hash (D-3). The manifest check, copy, quota, row and event are in `shareFile`. Every
   * refusal is audited (no names or content) and answered with `file.share_result`.
   */
  #onFileShare(frame: FileShareFrame): void {
    const answer = (result: Parameters<SandboxConnection["send"]>[0]) => this.send(result);
    const fail = (code: string, message: string) =>
      answer({
        v: 1,
        type: "file.share_result",
        request_id: frame.request_id,
        ok: false,
        error: { code, message },
      });
    const refuse = (
      reason: Parameters<WireContext["auditFileShareRefused"]>[2]["reason"],
      message: string,
    ) => {
      this.#ctx.auditFileShareRefused(this.target, this.sandboxId, {
        reason,
        runId: frame.run_id,
        toolCallId: frame.tool_call_id,
      });
      fail("not_allowed", message);
    };
    if (!this.hasCapability(CAPABILITY_FILES)) {
      refuse("capability_missing", "This sandbox did not announce file sharing.");
      return;
    }
    const check = this.#checkToolRun(frame.run_id, frame.thread_id, "file.share");
    if (check === "violation") return;
    if (check === "ended") {
      refuse("run_not_active", "The run has ended, so the file was not shared.");
      return;
    }
    const verdict = this.#allowedArtifacts.check(
      frame.run_id,
      frame.tool_call_id,
      frame.tool,
      frame.input,
    );
    if (verdict !== "ok") {
      refuse(
        verdict,
        verdict === "input_mismatch"
          ? "The file differs from the call that was allowed."
          : "This tool call was not allowed for this tool.",
      );
      return;
    }
    if (this.#fileShares >= this.#ctx.tuning.maxPendingArtifactPuts) {
      fail("storage_failed", "Too many files are being shared. Try again.");
      return;
    }
    this.#fileShares += 1;
    void shareFile(this.#ctx.fileShare, this.target, frame)
      .catch((err: unknown) => {
        this.log.error({ err }, "file.share failed");
        return {
          ok: false,
          code: "storage_failed",
          message: "The file could not be shared. Try again.",
        } as const;
      })
      .then((result) => {
        this.#fileShares -= 1;
        if (result.ok) {
          answer({
            v: 1,
            type: "file.share_result",
            request_id: frame.request_id,
            ok: true,
            ...result.file,
          });
          return;
        }
        if ("refusal" in result && result.refusal) {
          this.#ctx.auditFileShareRefused(this.target, this.sandboxId, {
            reason: result.refusal,
            runId: frame.run_id,
            toolCallId: frame.tool_call_id,
          });
        }
        fail(result.code, result.message);
      });
  }

  /** `file.edit_propose` (KOBE-462): checks and record in `file-edit-propose.ts`. */
  #onFileEditPropose(frame: FileEditProposeFrame): void {
    onFileEditPropose(
      {
        db: this.#ctx.db,
        target: this.target,
        runMaxEvents: this.#ctx.tuning.runMaxEvents,
        log: this.log,
        hasCapability: this.hasCapability(CAPABILITY_FILE_EDITS),
        runCheck: () => this.#checkToolRun(frame.run_id, frame.thread_id, "file.edit_propose"),
        verdict: () =>
          this.#allowedArtifacts.consume(frame.run_id, frame.tool_call_id, frame.tool, frame.input),
        send: (out) => this.send(out),
      },
      frame,
    );
  }

  /** `file.open` (KOBE-484): checks and record in `file-open.ts`; rides `file_edits`. */
  #onFileOpen(frame: FileOpenFrame): void {
    onFileOpen(
      {
        db: this.#ctx.db,
        target: this.target,
        runMaxEvents: this.#ctx.tuning.runMaxEvents,
        log: this.log,
        hasCapability: this.hasCapability(CAPABILITY_FILE_EDITS),
        runCheck: () => this.#checkToolRun(frame.run_id, frame.thread_id, "file.open"),
        verdict: () =>
          this.#allowedArtifacts.consume(frame.run_id, frame.tool_call_id, frame.tool, frame.input),
        send: (out) => this.send(out),
      },
      frame,
    );
  }

  /**
   * `notebook.output` (KOBE-464, NB14): only for a `notebook.execute` this connection delivered and
   * has not had answered, for the same thread; the run and exec ids come from that command. Late
   * outputs of an answered command are dropped; anything else is a lease violation.
   */
  #onNotebookOutput(frame: NotebookOutputFrame, bytes: number): void {
    const issued = this.#delivery.peekIssued(frame.command_id);
    if (issued === "answered") {
      this.#ctx.metrics.notebookOutputsDropped += 1;
      return;
    }
    const exec = issued?.notebook;
    if (exec === undefined || exec.threadId !== frame.thread_id) {
      this.#violate("unknown_command", "notebook.output");
      return;
    }
    this.#notebookOutputs.accept(frame.command_id, exec, frame, bytes);
  }

  /** `notebook.run` (KOBE-464, `run_python`): checks and execution in `notebook-run.ts`. */
  #onNotebookRun(frame: NotebookRunFrame): void {
    onNotebookRun(
      {
        db: this.#ctx.db,
        target: this.target,
        files: this.#ctx.notebooks,
        log: this.log,
        hasCapability: this.hasCapability(CAPABILITY_NOTEBOOKS),
        runCheck: () => this.#checkToolRun(frame.run_id, frame.thread_id, "notebook.run"),
        verdict: () =>
          this.#allowedArtifacts.consume(frame.run_id, frame.tool_call_id, frame.tool, frame.input),
        execute: (execute, timeoutMs) => this.#delivery.notebookExecute(execute, timeoutMs),
        send: (out) => this.send(out),
      },
      frame,
    );
  }

  /** `skill.draft_save` (KOBE-442): checks and save in `skill-draft-save.ts`. */
  #onSkillDraftSave(frame: SkillDraftSaveFrame): void {
    onSkillDraftSave(
      {
        ctx: this.#ctx,
        target: this.target,
        sandboxId: this.sandboxId,
        log: this.log,
        hasCapability: this.hasCapability(CAPABILITY_SKILL_DRAFTS),
        runCheck: () => this.#checkToolRun(frame.run_id, frame.thread_id, "skill.draft_save"),
        verdict: () =>
          // Single use (review M1): one allowed call, or one approval, is one save.
          this.#allowedArtifacts.consume(frame.run_id, frame.tool_call_id, frame.tool, frame.input),
        inFlight: this.#skillDraftSaves,
        send: (out) => this.send(out),
      },
      frame,
    );
  }

  /**
   * `web_search.query` (KOBE-114). Accepted only if this connection announced `web_search`, the
   * run is leased here and active, and this `web_search` call was allowed here with the same
   * canonical input hash (D-3). The server then decides availability (site provider, team
   * opt-in), opens the key and searches; "unavailable" is an answer, not an error. Refusals are
   * audited (never the query).
   */
  #onWebSearch(frame: WebSearchQueryFrame): void {
    const answer = (result: Parameters<SandboxConnection["send"]>[0]) => this.send(result);
    const fail = (code: string, message: string) =>
      answer({
        v: 1,
        type: "web_search.result",
        request_id: frame.request_id,
        ok: false,
        error: { code, message },
      });
    const refuse = (
      reason: Parameters<WireContext["auditWebSearchRefused"]>[2]["reason"],
      message: string,
    ) => {
      this.#ctx.auditWebSearchRefused(this.target, this.sandboxId, {
        reason,
        runId: frame.run_id,
        toolCallId: frame.tool_call_id,
      });
      fail("not_allowed", message);
    };
    if (!this.hasCapability(CAPABILITY_WEB_SEARCH)) {
      refuse("capability_missing", "This sandbox did not announce web search.");
      return;
    }
    const check = this.#checkToolRun(frame.run_id, frame.thread_id, "web_search.query");
    if (check === "violation") return;
    if (check === "ended") {
      refuse("run_not_active", "The run has ended, so the search was not run.");
      return;
    }
    const verdict = this.#allowedArtifacts.consume(
      frame.run_id,
      frame.tool_call_id,
      frame.tool,
      frame.input,
    );
    if (verdict !== "ok") {
      refuse(
        verdict,
        verdict === "input_mismatch"
          ? "The search differs from the call that was allowed."
          : verdict === "replayed"
            ? "This search was already run; ask the model to search again."
            : "This tool call was not allowed for this tool.",
      );
      return;
    }
    if (this.#webSearches >= this.#ctx.tuning.maxPendingArtifactPuts) {
      fail("rate_limited", "Too many searches are running. Try again.");
      return;
    }
    this.#webSearches += 1;
    const { teamId } = this.target;
    void withTeam(this.#ctx.db, teamId, (tx) =>
      isActiveMessageRun(tx, teamId, frame.run_id, frame.thread_id),
    )
      .then((active) => {
        if (active) return true;
        // A compaction (KOBE-213) or an ended run, from the database: no search.
        this.#webSearches -= 1;
        refuse("run_not_active", "The run is not an active conversation turn; no search.");
        return false;
      })
      .then((go) => (go ? this.#search(frame, answer, fail) : undefined))
      .catch((err: unknown) => {
        this.#webSearches -= 1;
        this.log.error({ err }, "web_search run check failed");
        fail("search_failed", "The search could not be run. Try again.");
      });
  }

  #search(
    frame: WebSearchQueryFrame,
    answer: (result: Parameters<SandboxConnection["send"]>[0]) => unknown,
    fail: (code: string, message: string) => void,
  ): Promise<void> {
    return this.#ctx.webSearch
      .search(this.target.teamId, frame.input, {
        runId: frame.run_id,
        toolCallId: frame.tool_call_id,
        sandboxId: this.sandboxId,
        userId: this.target.userId,
      })
      .catch((err: unknown) => {
        this.log.error({ err }, "web_search failed");
        return {
          kind: "error",
          code: "search_failed",
          message: "The search could not be run. Try again.",
        } as const;
      })
      .then((result) => {
        this.#webSearches -= 1;
        if (result.kind === "results") {
          answer({
            v: 1,
            type: "web_search.result",
            request_id: frame.request_id,
            ok: true,
            available: true,
            provider: result.provider,
            query: frame.input.query,
            results: [...result.results],
          });
        } else if (result.kind === "unavailable") {
          answer({
            v: 1,
            type: "web_search.result",
            request_id: frame.request_id,
            ok: true,
            available: false,
            reason: result.reason,
            message: result.message,
          });
        } else {
          fail(result.code, result.message);
        }
      });
  }

  /**
   * `memory.put` (KOBE-156). Accepted only if this connection announced `memory`, the run is
   * leased here and active, and this `remember` call was allowed here with the same canonical
   * input hash (D-3). Scope switches, project membership, the approval of a project write and the
   * store are in `putMemory`. Every refusal is audited (reason only) and answered `memory.result`.
   */
  #onMemoryPut(frame: Extract<SandboxToServerFrame, { type: "memory.put" }>): void {
    const answer = (reply: MemoryReply) =>
      this.send({ v: 1, type: "memory.result", request_id: frame.request_id, ...reply });
    const audit = (
      reason: MemoryRefusal | "capability_missing" | "input_mismatch",
      scope?: "user" | "project",
    ) =>
      this.#ctx.auditMemoryRefused(this.target, this.sandboxId, {
        op: "put",
        reason,
        scope: scope ?? frame.input.scope,
        runId: frame.run_id,
        toolCallId: frame.tool_call_id,
      });
    const refuse = (reason: Parameters<typeof audit>[0], message: string) => {
      audit(reason);
      answer({ ok: false, error: { code: "not_allowed", message } });
    };
    if (!this.hasCapability(CAPABILITY_MEMORY)) {
      refuse("capability_missing", "This sandbox did not announce memory.");
      return;
    }
    const check = this.#checkToolRun(frame.run_id, frame.thread_id, "memory.put");
    if (check === "violation") return;
    if (check === "ended") {
      refuse("run_not_active", "The run has ended, so nothing was remembered.");
      return;
    }
    const verdict = this.#allowedArtifacts.check(
      frame.run_id,
      frame.tool_call_id,
      "remember",
      frame.input,
    );
    if (verdict !== "ok") {
      refuse(
        verdict === "input_mismatch" ? "input_mismatch" : "not_allowed",
        verdict === "input_mismatch"
          ? "The memory differs from the call that was allowed."
          : "This tool call was not allowed for this tool.",
      );
      return;
    }
    if (this.#memoryOps >= this.#ctx.tuning.maxPendingArtifactPuts) {
      answer({
        ok: false,
        error: {
          code: "storage_failed",
          message: "Too many memory writes are waiting. Try again.",
        },
      });
      return;
    }
    this.#memoryOps += 1;
    const outcome = putMemory(this.#ctx.memory, {
      teamId: this.target.teamId,
      userId: this.target.userId,
      runId: frame.run_id,
      threadId: frame.thread_id,
      connectionId: this.id,
      toolCallId: frame.tool_call_id,
      input: frame.input,
      signal: this.#memoryAbort.signal,
      refused: audit,
    });
    // The slot frees once the sandbox is answered; a project write waiting for approval after its
    // `pending_approval` answer is bounded by the approvals per run (broker), not by this counter.
    void outcome.reply.then(answer).finally(() => {
      this.#memoryOps -= 1;
    });
  }

  /**
   * `project.file_propose` (KOBE-162). Accepted only if this connection announced `projects`, the
   * run is leased here and active, and this `propose_project_file` call was allowed here with the
   * same canonical input hash (D-3). The thread's project, membership, the pushed workspace entry,
   * the signed approval and the copy are in `proposeProjectFile`. Every refusal is audited (reason
   * only) and answered `project.file_propose_result`.
   */
  #onProjectFilePropose(
    frame: Extract<SandboxToServerFrame, { type: "project.file_propose" }>,
  ): void {
    const answer = (reply: ProposeReply) =>
      this.send({
        v: 1,
        type: "project.file_propose_result",
        request_id: frame.request_id,
        ...reply,
      });
    const audit = (reason: ProposeRefusal | "capability_missing" | "input_mismatch") =>
      this.#ctx.auditProjectFileRefused(this.target, this.sandboxId, {
        reason,
        runId: frame.run_id,
        toolCallId: frame.tool_call_id,
      });
    const refuse = (reason: Parameters<typeof audit>[0], message: string) => {
      audit(reason);
      answer({ ok: false, error: { code: "not_allowed", message } });
    };
    if (!this.hasCapability(CAPABILITY_PROJECTS)) {
      refuse("capability_missing", "This sandbox did not announce projects.");
      return;
    }
    const check = this.#checkToolRun(frame.run_id, frame.thread_id, "project.file_propose");
    if (check === "violation") return;
    if (check === "ended") {
      refuse("run_not_active", "The run has ended, so nothing was added.");
      return;
    }
    const verdict = this.#allowedArtifacts.check(
      frame.run_id,
      frame.tool_call_id,
      "propose_project_file",
      frame.input,
    );
    if (verdict !== "ok") {
      refuse(
        verdict === "input_mismatch" ? "input_mismatch" : "not_allowed",
        verdict === "input_mismatch"
          ? "The file differs from the call that was allowed."
          : "This tool call was not allowed for this tool.",
      );
      return;
    }
    if (this.#projectProposals >= this.#ctx.tuning.maxPendingArtifactPuts) {
      answer({
        ok: false,
        error: { code: "storage_failed", message: "Too many proposals are waiting. Try again." },
      });
      return;
    }
    this.#projectProposals += 1;
    const outcome = proposeProjectFile(this.#ctx.projectFiles, {
      teamId: this.target.teamId,
      userId: this.target.userId,
      runId: frame.run_id,
      threadId: frame.thread_id,
      connectionId: this.id,
      toolCallId: frame.tool_call_id,
      input: frame.input,
      workspace: frame.workspace,
      signal: this.#memoryAbort.signal,
      refused: audit,
    });
    void outcome.reply.then(answer).finally(() => {
      this.#projectProposals -= 1;
    });
  }

  /** `memory.read` (KOBE-156): a read, so no allowed-call binding; same capability and lease rules. */
  #onMemoryRead(frame: Extract<SandboxToServerFrame, { type: "memory.read" }>): void {
    const answer = (reply: MemoryReply) =>
      this.send({ v: 1, type: "memory.result", request_id: frame.request_id, ...reply });
    const audit = (
      reason: MemoryRefusal | "capability_missing" | "input_mismatch",
      scope?: "user" | "project",
    ) =>
      this.#ctx.auditMemoryRefused(this.target, this.sandboxId, {
        op: "read",
        reason,
        ...(scope ? { scope } : {}),
        runId: frame.run_id,
        toolCallId: frame.tool_call_id,
      });
    const refuse = (reason: Parameters<typeof audit>[0], message: string) => {
      audit(reason);
      answer({ ok: false, error: { code: "not_allowed", message } });
    };
    if (!this.hasCapability(CAPABILITY_MEMORY)) {
      refuse("capability_missing", "This sandbox did not announce memory.");
      return;
    }
    const check = this.#checkToolRun(frame.run_id, frame.thread_id, "memory.read");
    if (check === "violation") return;
    if (check === "ended") {
      refuse("run_not_active", "The run has ended.");
      return;
    }
    // D-3: the server decides every tool call; a recall that policy did not allow (deny rule, the
    // agent's tool list, approval mode) is not served, whatever the sandbox sends.
    const verdict = this.#allowedArtifacts.check(
      frame.run_id,
      frame.tool_call_id,
      "recall",
      frame.input,
    );
    if (verdict !== "ok") {
      refuse(
        verdict === "input_mismatch" ? "input_mismatch" : "not_allowed",
        verdict === "input_mismatch"
          ? "The recall differs from the call that was allowed."
          : "This tool call was not allowed for this tool.",
      );
      return;
    }
    if (this.#memoryOps >= this.#ctx.tuning.maxPendingArtifactPuts) {
      answer({
        ok: false,
        error: {
          code: "storage_failed",
          message: "Too many memory requests are waiting. Try again.",
        },
      });
      return;
    }
    this.#memoryOps += 1;
    void readMemory(this.#ctx.memory, {
      teamId: this.target.teamId,
      userId: this.target.userId,
      runId: frame.run_id,
      threadId: frame.thread_id,
      input: frame.input,
      refused: audit,
    })
      .then(answer)
      .finally(() => {
        this.#memoryOps -= 1;
      });
  }

  #onCommandResult(frame: CommandResultFrame): void {
    const issued = this.#delivery.takeIssued(frame.command_id);
    if (issued === "answered") return;
    if (issued === undefined) {
      this.#violate("unknown_command", "command.result");
      return;
    }
    const outcome: CommandOutcome = frame.ok
      ? frame.data === undefined
        ? { ok: true }
        : { ok: true, data: frame.data }
      : { ok: false, error: frame.error };
    if (issued.notebook !== undefined) {
      // NB14: the outputs this execution sent are stored before its answer is recorded.
      void this.#notebookOutputs
        .drain(frame.command_id)
        .finally(() => this.#delivery.settle(issued, outcome));
      return;
    }
    this.#delivery.settle(issued, outcome);
  }

  /**
   * The one answer to a `thread.compact` this connection delivered (KOBE-213), for the same thread.
   * Anything else (an unknown or duplicate command id, another command's id, another thread) is a
   * lease violation; a mismatched answer still settles its command, as failed, so nobody waits.
   */
  #onCompactResult(frame: Extract<SandboxToServerFrame, { type: "thread.compact_result" }>): void {
    const issued = this.#delivery.takeIssued(frame.command_id);
    if (issued === "answered") return;
    const matches =
      issued !== undefined &&
      issued.kind === "row" &&
      issued.commandKind === "thread.compact" &&
      issued.threadId === frame.thread_id;
    if (!matches) {
      if (issued !== undefined) {
        this.#delivery.settle(issued, {
          ok: false,
          error: { code: "malformed_result", message: "a compaction result for another command" },
        });
      }
      this.#violate("unknown_run", "thread.compact_result");
      return;
    }
    const { v: _v, type: _t, command_id: _c, thread_id: _th, ok, ...rest } = frame;
    this.#delivery.settle(
      issued,
      ok ? { ok: true, data: rest } : { ok: false, error: (rest as { error: ErrorInfo }).error },
    );
  }

  #onUiRequest(frame: Extract<SandboxToServerFrame, { type: "pi.ui_request" }>): void {
    if (frame.run_id !== undefined) {
      if (this.#checkRun(frame.run_id, frame.thread_id, "pi.ui_request") !== "ok") return;
    } else if (!this.#checkThread(frame.thread_id, "pi.ui_request")) {
      return;
    }
    const key = `${frame.thread_id}:${frame.request.id}`;
    if (this.#uiSeen.has(key)) return; // re-sent after a reconnect (KOBE-23): answered once
    remember(this.#uiSeen, key, UI_DEDUPE_MAX);
    Promise.resolve()
      .then(() =>
        this.#ctx.ui.handle({
          target: this.target,
          threadId: frame.thread_id,
          ...(frame.run_id === undefined ? {} : { runId: frame.run_id }),
          request: frame.request,
        }),
      )
      .then((response) => {
        if (response)
          this.send({ v: 1, type: "pi.ui_response", thread_id: frame.thread_id, response });
      })
      .catch((err: unknown) => this.log.warn({ err }, "ui request handling failed"));
  }

  #onPiExited(threadId: string, exitCode: number | null, signal: string | null): void {
    if (!this.#checkThread(threadId, "pi.exited")) return;
    this.log.warn({ thread_id: threadId, exit_code: exitCode, signal }, "Pi exited");
    for (const [runId, lease] of this.#leases) {
      if (lease.threadId !== threadId || lease.ended) continue;
      this.endLease(runId);
      void this.interrupt(runId, "pi_exited");
    }
    this.#delivery.forgetSession(threadId);
  }

  /** Per-run token bucket for `policy.denied` events. */
  #takeDeniedToken(runId: string): boolean {
    const { deniedEventBurst, deniedEventsPerMinute } = this.#ctx.tuning;
    const now = Date.now();
    const b = this.#deniedBuckets.get(runId) ?? { tokens: deniedEventBurst, at: now };
    b.tokens = Math.min(
      deniedEventBurst,
      b.tokens + ((now - b.at) / 60_000) * deniedEventsPerMinute,
    );
    b.at = now;
    this.#deniedBuckets.set(runId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
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
    const code = limit === "thread_entries" ? "thread_too_large" : "run_too_large";
    try {
      const { ended } = await withAppendTx(this.#ctx.db, this.target.teamId, (tx) =>
        endRunInTx(tx, this.target.teamId, runId, {
          status: "failed",
          error: { code, message: "The run produced more output than Kobe stores for one run." },
        }),
      );
      if (ended)
        this.#ctx.runEnded({ teamId: this.target.teamId, runId, threadId, status: "failed" });
    } catch (err) {
      this.log.error({ err, run_id: runId }, "could not fail an oversized run");
    }
  }

  /** Interrupts an active run (D14: never retried automatically). */
  async interrupt(runId: string, cause: InterruptCause): Promise<void> {
    try {
      const { ended, threadId } = await withAppendTx(this.#ctx.db, this.target.teamId, (tx) =>
        endRunInTx(tx, this.target.teamId, runId, { status: "interrupted" }, cause),
      );
      if (ended && threadId) {
        this.#ctx.metrics.runsInterrupted += 1;
        this.#ctx.runEnded({ teamId: this.target.teamId, runId, threadId, status: "interrupted" });
      }
    } catch (err) {
      this.log.error({ err, run_id: runId }, "could not interrupt run");
    }
  }

  // ------------------------------------------------------------------ hello

  async #hello(hello: HelloFrame): Promise<void> {
    const ctx = this.#ctx;
    if (hello.sandbox_id !== this.sandboxId) {
      ctx.auditTokenRejected({ sandboxId: this.sandboxId, ...this.target }, "sandbox_mismatch");
      this.close("unauthorized", "sandbox_id does not match the token");
      return;
    }
    if (!supportedPiVersion(hello.pi_version)) {
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
    const { teamId } = this.target;
    const offered = new Map(hello.runs.map((r) => [r.run_id, r]));
    const { listed, lost, orphans } = await withTeam(ctx.db, teamId, async (tx) => {
      const active = await activeLeasedRuns(tx, this.target, this.sandboxId);
      // A compaction is never kept (KOBE-213): its `thread.compact` was issued on the old
      // connection, so no answer can arrive on this one; it ends (failed) and the agent, not
      // seeing it listed, aborts it. Its thread is released, its queue moves on.
      const resumable = (r: (typeof active)[number]) =>
        r.kind === "message" && offered.get(r.runId)?.thread_id === r.threadId;
      const keep = active.filter(resumable);
      const gone = active.filter((r) => !resumable(r));
      return {
        listed: keep,
        lost: gone,
        orphans: await orphanedDeliveries(tx, this.target, this.id),
      };
    });
    for (const run of listed) {
      this.#threads.add(run.threadId);
      this.#leases.set(run.runId, {
        threadId: run.threadId,
        ended: false,
        compaction: false, // never kept (above)
        ingest: this.#newIngest(run.runId, run.threadId, run.sandboxSeq),
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
    // Runs the sandbox no longer has (Pi or agent restarted, volume lost): interrupted, never
    // resumed (D14). Runs it offers that we don't list are aborted by the agent.
    for (const run of lost) await this.interrupt(run.runId, "not_resumed");
    await this.#reconcileOrphans(orphans, new Set(listed.map((r) => r.runId)));
    if ((this.#state as State) === "closed") return;
    this.#state = "ready";
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
      { sandbox_id: this.sandboxId, resumed: listed.length, interrupted: lost.length },
      "sandbox connected",
    );
    this.#startTimers();
    this.#delivery.poke();
  }

  /** Commands delivered on an earlier connection never got their result (ids are per connection). */
  async #reconcileOrphans(
    orphans: readonly { id: string; kind: string; runId: string | null }[],
    resumed: ReadonlySet<string>,
  ): Promise<void> {
    for (const o of orphans) {
      const outcome: CommandOutcome =
        o.kind === "run.start" && o.runId !== null && resumed.has(o.runId)
          ? { ok: true, data: { resumed: true } }
          : {
              ok: false,
              error: {
                code: o.kind === "run.start" ? "sandbox_lost" : "connection_lost",
                message: "the sandbox reconnected before answering",
              },
            };
      await withTeam(this.#ctx.db, this.target.teamId, (tx) =>
        completeCommand(tx, this.#ctx.bus, this.target.teamId, o.id, outcome),
      );
    }
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
    // The session token expires (15 min, KOBE-22): the sandbox reconnects with a fresh one and
    // resumes its runs from their durable cursors.
    const expiresIn = this.#tokenExpiresAt - Date.now() + tuning.tokenExpiryGraceMs;
    this.#later(Math.max(0, expiresIn), () => this.close("unauthorized", "session token expired"));
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
    this.#timers = [];
    for (const abort of this.#policyPending.values()) abort.abort();
    this.#policyPending.clear();
    this.#memoryAbort.abort();
    for (const lease of this.#leases.values()) lease.ingest.close();
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
