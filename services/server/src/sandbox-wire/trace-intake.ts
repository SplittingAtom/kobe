import {
  SANDBOX_SPAN_CONTENT_KEYS,
  TRACE_DROPPED_ATTRIBUTE,
  TRACE_SPAN_CLOCK_SKEW_MS,
  TRACE_SPAN_MAX_DEPTH,
  TRACE_SPANS_FRAMES_BURST,
  TRACE_SPANS_FRAMES_PER_SECOND,
  TRACE_SPANS_LATE_GRACE_MS,
  TRACE_SPANS_PER_RUN_MAX,
  parseSandboxSpan,
  runRootSpanId,
  runTraceId,
  type SandboxSpan,
  type TraceSpansFrame,
} from "@kobe/protocol";
import { mapSandboxSpanId } from "@kobe/protocol/node";
import {
  idAttributes,
  sessionAttributes,
  type Attributes,
  type RelaySpan,
  type RunRootSpan,
} from "@kobe/telemetry";
import type { RelayBudget } from "./trace-budget.js";

/**
 * Relayed sandbox spans, one instance per replica (KOBE-274; contract in `@kobe/protocol`
 * sandbox-wire/trace-frames.ts). Per-run state (span cap, seen-set, command span ids) lives here,
 * not on a connection, so a reconnect to this replica keeps it; it is bounded and freed after the
 * run's grace period. A run resumed on another replica starts afresh there (documented). The
 * connection checks the lease and the frame rate first ({@link TraceFrameRate}); this class takes
 * what the lease allowed, re-attributes it and hands it to the relay queue. It never blocks and
 * never throws at the connection: everything it refuses is dropped and counted.
 */
export interface TraceIntakeTuning {
  readonly framesPerSecond: number;
  readonly framesBurst: number;
  readonly perRunMax: number;
  readonly lateGraceMs: number;
  readonly clockSkewMs: number;
  readonly maxDepth: number;
  /** Runs tracked per replica; ended ones go first, then the oldest. */
  readonly maxRuns: number;
  /** Most agent-reported drops counted per run (the number is the sandbox's). */
  readonly maxAgentDropped: number;
}

export const TRACE_INTAKE_DEFAULTS: TraceIntakeTuning = {
  framesPerSecond: TRACE_SPANS_FRAMES_PER_SECOND,
  framesBurst: TRACE_SPANS_FRAMES_BURST,
  perRunMax: TRACE_SPANS_PER_RUN_MAX,
  lateGraceMs: TRACE_SPANS_LATE_GRACE_MS,
  clockSkewMs: TRACE_SPAN_CLOCK_SKEW_MS,
  maxDepth: TRACE_SPAN_MAX_DEPTH,
  maxRuns: 4_096,
  maxAgentDropped: 100_000,
};

export interface TraceCounters {
  traceSpansRelayed: number;
  traceSpansDropped: number;
  traceFramesDropped: number;
}

export interface TraceIntakeDeps {
  readonly key: Uint8Array;
  readonly budget: RelayBudget;
  readonly counters: TraceCounters;
  /** Content capture (site setting): off strips content keys at intake already. */
  readonly captureContent: boolean;
  /** The relay queue; returns how many spans it accepted. */
  readonly offer: (spans: readonly RelaySpan[]) => number;
  readonly recordRoot: (root: RunRootSpan) => void;
  readonly now?: () => number;
  readonly tuning?: Partial<TraceIntakeTuning>;
}

/** Who a run belongs to, from the connection that holds its lease (never from a frame). */
export interface RunOwner {
  readonly teamId: string;
  /** The sandbox's member, who owns every thread leased to it (`user.id`). */
  readonly userId: string;
  readonly sandboxId: string;
}

interface RunTrace {
  owner: RunOwner;
  readonly threadId: string;
  readonly startedAtMs: number;
  /** The run's start carried a trace context (only then are its frames taken). */
  traced: boolean;
  /** Server span ids the sandbox was given (`trace.traceparent`), kept as parents unchanged. */
  readonly commandSpanIds: Set<string>;
  /** Sandbox span id → its sandbox parent id, for duplicates, cycles and depth. */
  readonly parents: Map<string, string>;
  /** Exported id of the run's `sandbox.run` span, once seen. */
  runSpanId: string | undefined;
  /** Tool call id → tool name, from the server's own policy decisions. */
  readonly tools: Map<string, string>;
  dropped: number;
  agentDropped: number;
  endedAtMs: number | undefined;
  rootTimer: NodeJS.Timeout | undefined;
}

const UNKNOWN_TOOL = "unknown";
/** A tool call id worth exporting: a short plain token, never free text. */
const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export class TraceIntake {
  readonly #deps: TraceIntakeDeps;
  readonly #tuning: TraceIntakeTuning;
  readonly #now: () => number;
  readonly #runs = new Map<string, RunTrace>();

  constructor(deps: TraceIntakeDeps) {
    this.#deps = deps;
    this.#tuning = { ...TRACE_INTAKE_DEFAULTS, ...deps.tuning };
    this.#now = deps.now ?? Date.now;
  }

  get tuning(): TraceIntakeTuning {
    return this.#tuning;
  }

  /**
   * A run leased to a connection of this replica (every run gets a `kobe.run` root when it ends
   * here). Leased again after a reconnect: its state is kept, only the holder is updated.
   */
  track(runId: string, threadId: string, startedAt: Date | null, owner: RunOwner): void {
    const known = this.#runs.get(runId);
    if (known) {
      if (known.threadId === threadId && known.owner.teamId === owner.teamId) known.owner = owner;
      return;
    }
    this.#runs.set(runId, {
      owner,
      threadId,
      startedAtMs: startedAt?.getTime() ?? this.#now(),
      traced: false,
      commandSpanIds: new Set(),
      parents: new Map(),
      runSpanId: undefined,
      tools: new Map(),
      dropped: 0,
      agentDropped: 0,
      endedAtMs: undefined,
      rootTimer: undefined,
    });
    this.#evict();
  }

  /** Whether the replica already knows the run as traced (a resume on this replica). */
  isTraced(runId: string): boolean {
    return this.#runs.get(runId)?.traced === true;
  }

  /**
   * The run's start (or compaction) was delivered with a trace context naming `commandSpanId`; none
   * for a run resumed on this connection (its context went out on an earlier one).
   */
  traced(runId: string, commandSpanId?: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    run.traced = true;
    if (commandSpanId !== undefined && run.commandSpanIds.size < 16) {
      run.commandSpanIds.add(commandSpanId);
    }
  }

  /** The server decided a tool call of the run; `name` only when it is a known tool. */
  noteToolCall(runId: string, toolCallId: string, name: string | undefined): void {
    const run = this.#runs.get(runId);
    if (!run || run.tools.size >= this.#tuning.perRunMax) return;
    run.tools.set(toolCallId, name ?? UNKNOWN_TOOL);
  }

  /** The run ended: its frames are still taken for the grace period, then its root is recorded. */
  ended(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run || run.endedAtMs !== undefined) return;
    run.endedAtMs = this.#now();
    run.rootTimer = setTimeout(() => this.#finish(runId), this.#tuning.lateGraceMs);
    run.rootTimer.unref();
  }

  /**
   * A run of this team, on this sandbox, that ended less than the grace period ago (its lease may
   * be forgotten by the connection's count cap; a late frame for it is dropped, not a violation).
   */
  recentlyEnded(runId: string, threadId: string, owner: RunOwner): boolean {
    const run = this.#runs.get(runId);
    return (
      run?.endedAtMs !== undefined &&
      run.threadId === threadId &&
      run.owner.teamId === owner.teamId &&
      run.owner.sandboxId === owner.sandboxId
    );
  }

  /** Counts a frame the connection refused (no capability, unknown run within grace). */
  dropFrame(runId: string | undefined, spans: number): void {
    this.#deps.counters.traceFramesDropped += 1;
    const run = runId === undefined ? undefined : this.#runs.get(runId);
    if (run) run.dropped += spans;
    this.#deps.counters.traceSpansDropped += spans;
  }

  /** A frame whose run and thread the connection checked against its leases. */
  accept(frame: TraceSpansFrame, owner: RunOwner): void {
    const run = this.#runs.get(frame.run_id);
    if (
      !run ||
      !run.traced ||
      run.threadId !== frame.thread_id ||
      run.owner.teamId !== owner.teamId
    ) {
      this.dropFrame(frame.run_id, frame.spans.length);
      return;
    }
    const reported = Math.min(frame.dropped ?? 0, this.#tuning.maxAgentDropped - run.agentDropped);
    run.agentDropped += reported;
    run.dropped += reported;
    // The replica budget first: spans it refuses cost no parse and no HMAC.
    const allowed = this.#deps.budget.take(run.owner.teamId, frame.spans.length);
    const converted: RelaySpan[] = [];
    for (const raw of frame.spans.slice(0, allowed)) {
      const span = parseSandboxSpan(raw);
      const relay = span === undefined ? undefined : this.#convert(frame.run_id, run, span);
      if (relay !== undefined) converted.push(relay);
    }
    const taken = converted.length === 0 ? 0 : this.#deps.offer(converted);
    const lost = frame.spans.length - taken;
    run.dropped += lost;
    this.#deps.counters.traceSpansRelayed += taken;
    this.#deps.counters.traceSpansDropped += lost;
  }

  /** The replica shuts down: roots of ended runs now; live runs may resume elsewhere. */
  close(): void {
    for (const [runId, run] of this.#runs) {
      if (run.endedAtMs !== undefined) {
        clearTimeout(run.rootTimer);
        this.#finish(runId);
      }
    }
    this.#runs.clear();
  }

  #finish(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    this.#runs.delete(runId);
    this.#deps.recordRoot({
      runId,
      startMs: run.startedAtMs,
      endMs: run.endedAtMs ?? this.#now(),
      attributes: {
        ...this.#identity(runId, run),
        ...(run.dropped > 0 ? { [TRACE_DROPPED_ATTRIBUTE]: run.dropped } : {}),
      },
    });
  }

  #identity(runId: string, run: RunTrace): Attributes {
    const { teamId, userId, sandboxId } = run.owner;
    const threadId = run.threadId;
    return {
      ...idAttributes({ teamId, userId, threadId, runId, sandboxId }),
      ...sessionAttributes({ threadId, userId }),
    };
  }

  /** Validated span → exported span, or undefined to drop it (counted by the caller). */
  #convert(runId: string, run: RunTrace, span: SandboxSpan): RelaySpan | undefined {
    if (run.parents.has(span.span_id) || run.parents.size >= this.#tuning.perRunMax) {
      return undefined; // duplicate, or over the run's cap
    }
    const times = this.#clamp(run, span.start_ms, span.end_ms);
    if (times === undefined) return undefined;
    const parent = this.#parent(runId, run, span);
    if (parent === undefined) return undefined; // would close a cycle
    run.parents.set(span.span_id, span.parent_span_id);
    const spanId = mapSandboxSpanId(this.#deps.key, runId, span.span_id);
    if (span.name === "sandbox.run") run.runSpanId = spanId;
    return {
      name: span.name,
      traceId: runTraceId(runId),
      spanId,
      parentSpanId: parent,
      startMs: times.start,
      endMs: times.end,
      error: span.status === "error",
      attributes: {
        ...this.#attributes(run, span),
        ...(span.error_type === undefined ? {} : { "error.type": span.error_type }),
        ...this.#identity(runId, run),
      },
    };
  }

  #clamp(run: RunTrace, start: number, end: number): { start: number; end: number } | undefined {
    const { clockSkewMs, lateGraceMs } = this.#tuning;
    const now = this.#now();
    const low = run.startedAtMs - clockSkewMs;
    const high =
      Math.min(now, run.endedAtMs === undefined ? now : run.endedAtMs + lateGraceMs) + clockSkewMs;
    const clampedStart = Math.min(Math.max(start, low), high);
    const clampedEnd = Math.min(Math.max(end, low), high);
    return clampedEnd < clampedStart ? undefined : { start: clampedStart, end: clampedEnd };
  }

  /** The exported parent id: a command span kept, anything else remapped; cycles refused. */
  #parent(runId: string, run: RunTrace, span: SandboxSpan): string | undefined {
    const command = run.commandSpanIds.values().next().value ?? runRootSpanId(runId);
    if (span.name === "sandbox.run") {
      return run.commandSpanIds.has(span.parent_span_id) ? span.parent_span_id : command;
    }
    if (run.commandSpanIds.has(span.parent_span_id)) return span.parent_span_id;
    let cursor: string | undefined = span.parent_span_id;
    for (let depth = 0; cursor !== undefined; depth++) {
      if (cursor === span.span_id) return undefined;
      if (depth >= this.#tuning.maxDepth) return run.runSpanId ?? command;
      cursor = run.parents.get(cursor);
    }
    return mapSandboxSpanId(this.#deps.key, runId, span.parent_span_id);
  }

  #attributes(run: RunTrace, span: SandboxSpan): Attributes {
    const raw: Record<string, string | number> = Object.fromEntries(
      Object.entries(span.attributes).filter(
        (entry): entry is [string, string | number] => entry[1] !== undefined,
      ),
    );
    if (span.name === "sandbox.tool") {
      const callId = span.attributes["kobe.tool.call_id"];
      // Kept only for a call the server decided, and only as a plain id (some models write it).
      const name = run.tools.get(callId);
      const plainId = CALL_ID.test(callId);
      const { "kobe.tool.call_id": _callId, ...rest } = raw;
      return this.#withoutContent({
        ...rest,
        "kobe.tool.name": name ?? UNKNOWN_TOOL,
        ...(name === undefined || !plainId ? {} : { "kobe.tool.call_id": callId }),
      });
    }
    return this.#withoutContent(raw);
  }

  #withoutContent(attributes: Record<string, string | number>): Attributes {
    if (this.#deps.captureContent) return attributes;
    const content = new Set<string>(SANDBOX_SPAN_CONTENT_KEYS);
    return Object.fromEntries(Object.entries(attributes).filter(([k]) => !content.has(k)));
  }

  /** Over the cap: ended runs first (their roots recorded now), then the oldest live ones. */
  #evict(): void {
    if (this.#runs.size <= this.#tuning.maxRuns) return;
    for (const [runId, run] of this.#runs) {
      if (run.endedAtMs === undefined) continue;
      clearTimeout(run.rootTimer);
      this.#finish(runId);
      if (this.#runs.size <= this.#tuning.maxRuns) return;
    }
    for (const runId of this.#runs.keys()) {
      this.#runs.delete(runId);
      if (this.#runs.size <= this.#tuning.maxRuns) return;
    }
  }
}

/**
 * The per-connection frame rate for `trace.spans` (KOBE-274), charged after the frame decoded (the
 * type is the parsed one, whatever the key order), before its spans are parsed.
 */
export class TraceFrameRate {
  readonly #tuning: Pick<TraceIntakeTuning, "framesPerSecond" | "framesBurst">;
  readonly #counters: TraceCounters;
  readonly #now: () => number;
  #tokens: number;
  #at: number;

  constructor(
    tuning: Pick<TraceIntakeTuning, "framesPerSecond" | "framesBurst">,
    counters: TraceCounters,
    now: () => number = Date.now,
  ) {
    this.#tuning = tuning;
    this.#counters = counters;
    this.#now = now;
    this.#tokens = tuning.framesBurst;
    this.#at = now();
  }

  /** False: drop the frame (counted). */
  admit(): boolean {
    const now = this.#now();
    const elapsed = Math.max(0, now - this.#at) / 1000;
    this.#at = now;
    this.#tokens = Math.min(
      this.#tuning.framesBurst,
      this.#tokens + elapsed * this.#tuning.framesPerSecond,
    );
    if (this.#tokens < 1) {
      this.#counters.traceFramesDropped += 1;
      return false;
    }
    this.#tokens -= 1;
    return true;
  }
}
