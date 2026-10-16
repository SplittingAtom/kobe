import { randomBytes } from "node:crypto";
import type {
  SANDBOX_TURN_STOP_REASONS} from "@kobe/protocol";
import {
  SANDBOX_SPAN_CONTENT_MAX_CHARS,
  TRACE_SPANS_AGENT_BUFFER_MAX,
  TRACE_SPANS_AGENT_SEND_AFTER_END_MS,
  TRACE_SPANS_FLUSH_INTERVAL_MS,
  TRACE_SPANS_FRAME_MAX_BYTES,
  TRACE_SPANS_PER_FRAME_MAX,
  encodeFrame,
  formatTraceparent,
  parseSandboxSpan,
  parseTraceparent,
  type SandboxSpan,
  type TraceSpansFrame,
  type WireTraceContext,
} from "@kobe/protocol";

/**
 * Run spans of this sandbox (KOBE-274, contract in `@kobe/protocol` sandbox-wire/trace-frames.ts).
 * Recorded from Pi's RPC events only for runs whose start carried a trace context, and sent to the
 * server as `trace.spans` frames over the existing wire: the sandbox holds no collector endpoint
 * or credential. Bounded memory and never in a run's way: a full buffer drops spans and counts them.
 */
export interface RecorderDeps {
  /** Sends one encoded frame; false when not connected (the spans stay buffered). */
  readonly sendText: (text: string) => boolean;
  /** The run's current span as a `traceparent`, for Pi's model calls (null: none). */
  readonly onModelParent?: (runId: string, traceparent: string | null) => void;
  readonly now?: () => number;
  readonly flushIntervalMs?: number;
  readonly bufferMax?: number;
  readonly sendAfterEndMs?: number;
}

type Attributes = Record<string, string | number>;

interface Open {
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly name: SandboxSpan["name"];
  readonly startMs: number;
  readonly attributes: Attributes;
}

interface RunTrace {
  readonly threadId: string;
  readonly traceId: string;
  readonly contextParent: string;
  readonly capture: boolean;
  readonly compaction: boolean;
  /** The run's own span (`sandbox.run`, or `sandbox.compaction` for a compaction run). */
  root: Open;
  turn: Open | undefined;
  turns: number;
  turnToolCalls: number;
  readonly tools: Map<string, Open>;
  autoCompaction: Open | undefined;
  readonly denied: Set<string>;
  pending: SandboxSpan[];
  dropped: number;
  stopped: boolean;
  exited: boolean;
  endedAtMs: number | undefined;
}

const STOP_REASONS: Readonly<Record<string, (typeof SANDBOX_TURN_STOP_REASONS)[number]>> = {
  stop: "stop",
  length: "length",
  toolUse: "tool_use",
  error: "error",
  aborted: "aborted",
};

const newSpanId = (): string => {
  for (;;) {
    const id = randomBytes(8).toString("hex");
    if (id !== "0000000000000000") return id;
  }
};

/** Content as the server accepts it: text, at most the content cap, no U+0000. */
function contentOf(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    text = "";
  }
  return text.replaceAll("\u0000", "�").slice(0, SANDBOX_SPAN_CONTENT_MAX_CHARS);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export class TraceRecorder {
  readonly #deps: RecorderDeps;
  readonly #now: () => number;
  readonly #bufferMax: number;
  readonly #sendAfterEndMs: number;
  readonly #runs = new Map<string, RunTrace>();
  readonly #timer: NodeJS.Timeout;
  #buffered = 0;

  constructor(deps: RecorderDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#bufferMax = deps.bufferMax ?? TRACE_SPANS_AGENT_BUFFER_MAX;
    this.#sendAfterEndMs = deps.sendAfterEndMs ?? TRACE_SPANS_AGENT_SEND_AFTER_END_MS;
    this.#timer = setInterval(
      () => this.flush(),
      deps.flushIntervalMs ?? TRACE_SPANS_FLUSH_INTERVAL_MS,
    );
    this.#timer.unref();
  }

  /** Runs being recorded (tests and diagnostics). */
  get runIds(): string[] {
    return [...this.#runs.keys()];
  }

  /** A run (or compaction) starts; without a trace context nothing is recorded for it. */
  startRun(
    runId: string,
    threadId: string,
    trace: WireTraceContext | undefined,
    compaction = false,
  ): void {
    if (trace === undefined || this.#runs.has(runId)) return;
    const parsed = parseTraceparent(trace.traceparent);
    if (parsed === undefined || !parsed.sampled) return;
    const root: Open = {
      spanId: newSpanId(),
      parentSpanId: parsed.parentSpanId,
      name: compaction ? "sandbox.compaction" : "sandbox.run",
      startMs: this.#now(),
      attributes: compaction ? { "kobe.compaction.trigger": "command" } : {},
    };
    this.#runs.set(runId, {
      threadId,
      traceId: parsed.traceId,
      contextParent: parsed.parentSpanId,
      capture: trace.capture_content,
      compaction,
      root,
      turn: undefined,
      turns: 0,
      turnToolCalls: 0,
      tools: new Map(),
      autoCompaction: undefined,
      denied: new Set(),
      pending: [],
      dropped: 0,
      stopped: false,
      exited: false,
      endedAtMs: undefined,
    });
    this.#modelParent(runId, root.spanId);
  }

  /** The run was asked to stop (its run span ends `aborted`). */
  stopRequested(runId: string): void {
    const run = this.#live(runId);
    if (run) run.stopped = true;
  }

  /** kobe-policy's answer for a call (a denied call's tool span ends `blocked`). */
  noteDecision(runId: string, toolCallId: string, decision: "allow" | "deny"): void {
    const run = this.#live(runId);
    if (run && decision === "deny" && run.denied.size < 4096) run.denied.add(toolCallId);
  }

  onPiEvent(runId: string, event: Readonly<Record<string, unknown>>): void {
    const run = this.#live(runId);
    if (!run) return;
    switch (event.type) {
      case "turn_start":
        this.#turnStart(runId, run);
        return;
      case "message_end":
        this.#messageEnd(run, event);
        return;
      case "turn_end":
        this.#turnEnd(runId, run);
        return;
      case "tool_execution_start":
        this.#toolStart(run, event);
        return;
      case "tool_execution_end":
        this.#toolEnd(run, event);
        return;
      case "compaction_start":
        this.#compactionStart(run, event);
        return;
      case "compaction_end":
        this.#compactionEnd(run, event);
        return;
      default:
        return;
    }
  }

  /** A workspace sync of the run finished (the agent times it). */
  workspaceSync(
    runId: string,
    sync: {
      readonly direction: "push" | "pull";
      readonly startMs: number;
      readonly ok: boolean;
      readonly files?: number;
      readonly bytes?: number;
    },
  ): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    this.#end(
      run,
      {
        spanId: newSpanId(),
        parentSpanId: run.root.spanId,
        name: "sandbox.workspace_sync",
        startMs: sync.startMs,
        attributes: {
          "kobe.sync.direction": sync.direction,
          ...(sync.files === undefined ? {} : { "kobe.sync.files": sync.files }),
          ...(sync.bytes === undefined ? {} : { "kobe.sync.bytes": sync.bytes }),
        },
      },
      sync.ok ? undefined : "sync_failed",
    );
  }

  /** Pi exited under the run: what is open ends `pi_exited`. */
  piExited(runId: string): void {
    const run = this.#live(runId);
    if (run) run.exited = true;
  }

  /** The run ended: close what is open, send it, forget the run a little later. */
  runEnded(runId: string): void {
    const run = this.#live(runId);
    if (!run) return;
    const error = run.exited ? "pi_exited" : run.stopped ? "aborted" : undefined;
    for (const open of run.tools.values()) {
      this.#end(
        run,
        { ...open, attributes: { ...open.attributes, "kobe.tool.outcome": "aborted" } },
        error ?? "aborted",
      );
    }
    run.tools.clear();
    if (run.autoCompaction) this.#end(run, run.autoCompaction, error ?? "aborted");
    run.autoCompaction = undefined;
    if (run.turn) this.#closeTurn(run, error ?? "aborted");
    const outcome = run.exited ? "failed" : run.stopped ? "aborted" : "completed";
    this.#end(
      run,
      run.compaction
        ? run.root
        : { ...run.root, attributes: { "kobe.run.outcome": outcome, "kobe.turns": run.turns } },
      run.exited ? "pi_exited" : undefined,
    );
    run.endedAtMs = this.#now();
    this.#deps.onModelParent?.(runId, null);
    this.flush();
  }

  /** After a reconnect: runs the server no longer lists are forgotten, unsent spans included. */
  keepOnly(runIds: ReadonlySet<string>): void {
    for (const runId of [...this.#runs.keys()]) {
      if (!runIds.has(runId)) this.#forget(runId);
    }
  }

  /** Sends at most one frame per run; what does not fit waits for the next flush. */
  flush(): void {
    const now = this.#now();
    for (const [runId, run] of [...this.#runs]) {
      if (run.endedAtMs !== undefined && now - run.endedAtMs > this.#sendAfterEndMs) {
        this.#forget(runId);
        continue;
      }
      if (run.pending.length > 0) this.#sendOne(runId, run);
      if (run.endedAtMs !== undefined && run.pending.length === 0) this.#forget(runId);
    }
  }

  close(): void {
    clearInterval(this.#timer);
    this.#runs.clear();
    this.#buffered = 0;
  }

  #live(runId: string): RunTrace | undefined {
    const run = this.#runs.get(runId);
    return run?.endedAtMs === undefined ? run : undefined;
  }

  #forget(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    this.#buffered -= run.pending.length;
    this.#runs.delete(runId);
  }

  #modelParent(runId: string, spanId: string): void {
    const run = this.#runs.get(runId);
    if (run) this.#deps.onModelParent?.(runId, formatTraceparent(run.traceId, spanId));
  }

  #turnStart(runId: string, run: RunTrace): void {
    if (run.turn) this.#closeTurn(run, "aborted");
    run.turn = {
      spanId: newSpanId(),
      parentSpanId: run.root.spanId,
      name: "sandbox.turn",
      startMs: this.#now(),
      attributes: { "kobe.turn.index": run.turns },
    };
    run.turns += 1;
    run.turnToolCalls = 0;
    this.#modelParent(runId, run.turn.spanId);
  }

  #messageEnd(run: RunTrace, event: Readonly<Record<string, unknown>>): void {
    const message = event.message as { role?: unknown; stopReason?: unknown } | undefined;
    if (!run.turn || message?.role !== "assistant") return;
    const reason = STOP_REASONS[str(message.stopReason) ?? ""] ?? "other";
    run.turn = { ...run.turn, attributes: { ...run.turn.attributes, "kobe.stop_reason": reason } };
  }

  #turnEnd(runId: string, run: RunTrace): void {
    if (!run.turn) return;
    this.#closeTurn(
      run,
      run.turn.attributes["kobe.stop_reason"] === "error" ? "model_error" : undefined,
    );
    this.#modelParent(runId, run.root.spanId);
  }

  #closeTurn(run: RunTrace, error: SandboxSpan["error_type"]): void {
    const turn = run.turn;
    if (!turn) return;
    run.turn = undefined;
    this.#end(
      run,
      { ...turn, attributes: { ...turn.attributes, "kobe.tool_calls": run.turnToolCalls } },
      error,
    );
  }

  #toolStart(run: RunTrace, event: Readonly<Record<string, unknown>>): void {
    const callId = str(event.toolCallId);
    if (callId === undefined || run.tools.has(callId) || run.tools.size >= 256) return;
    const parentCall = str(event.parentToolCallId);
    const parent =
      (parentCall === undefined ? undefined : run.tools.get(parentCall)?.spanId) ??
      run.turn?.spanId ??
      run.root.spanId;
    run.turnToolCalls += 1;
    run.tools.set(callId, {
      spanId: newSpanId(),
      parentSpanId: parent,
      name: "sandbox.tool",
      startMs: this.#now(),
      attributes: {
        "kobe.tool.call_id": callId,
        ...(run.capture ? { "kobe.tool.input": contentOf(event.args) } : {}),
      },
    });
  }

  #toolEnd(run: RunTrace, event: Readonly<Record<string, unknown>>): void {
    const callId = str(event.toolCallId);
    const open = callId === undefined ? undefined : run.tools.get(callId);
    if (callId === undefined || open === undefined) return;
    run.tools.delete(callId);
    const blocked = run.denied.has(callId);
    const failed = event.isError === true;
    const outcome = blocked ? "blocked" : failed ? "error" : "ok";
    this.#end(
      run,
      {
        ...open,
        attributes: {
          ...open.attributes,
          "kobe.tool.outcome": outcome,
          ...(run.capture ? { "kobe.tool.output": contentOf(event.result) } : {}),
        },
      },
      blocked ? "blocked" : failed ? "tool_error" : undefined,
    );
  }

  #compactionStart(run: RunTrace, event: Readonly<Record<string, unknown>>): void {
    if (run.compaction || run.autoCompaction) return; // a compaction run is its own span
    const reason = str(event.reason);
    run.autoCompaction = {
      spanId: newSpanId(),
      parentSpanId: run.turn?.spanId ?? run.root.spanId,
      name: "sandbox.compaction",
      startMs: this.#now(),
      attributes: {
        "kobe.compaction.trigger":
          reason === "threshold" || reason === "overflow" ? reason : "command",
      },
    };
  }

  #compactionEnd(run: RunTrace, event: Readonly<Record<string, unknown>>): void {
    const result = event.result as { tokensBefore?: unknown } | undefined;
    const before = result?.tokensBefore;
    const tokens =
      typeof before === "number" && Number.isSafeInteger(before) && before >= 0
        ? { "kobe.compaction.tokens_before": before }
        : {};
    const failed = event.aborted === true || typeof event.errorMessage === "string";
    if (run.compaction) {
      run.root = { ...run.root, attributes: { ...run.root.attributes, ...tokens } };
      return;
    }
    const open = run.autoCompaction;
    if (!open) return;
    run.autoCompaction = undefined;
    this.#end(
      run,
      { ...open, attributes: { ...open.attributes, ...tokens } },
      failed ? "aborted" : undefined,
    );
  }

  /** Ends a span into the run's buffer (validated; dropped and counted when it does not fit). */
  #end(run: RunTrace, open: Open, error: SandboxSpan["error_type"]): void {
    const end = Math.max(this.#now(), open.startMs);
    const span = parseSandboxSpan({
      span_id: open.spanId,
      parent_span_id: open.parentSpanId,
      name: open.name,
      start_ms: open.startMs,
      end_ms: end,
      status: error === undefined ? "ok" : "error",
      ...(error === undefined ? {} : { error_type: error }),
      attributes: open.attributes,
    });
    if (span === undefined || this.#buffered >= this.#bufferMax) {
      run.dropped += 1;
      return;
    }
    run.pending = [...run.pending, span];
    this.#buffered += 1;
  }

  #sendOne(runId: string, run: RunTrace): void {
    let batch = run.pending.slice(0, TRACE_SPANS_PER_FRAME_MAX);
    for (;;) {
      const frame: TraceSpansFrame = {
        v: 1,
        type: "trace.spans",
        run_id: runId,
        thread_id: run.threadId,
        spans: batch,
        ...(run.dropped > 0 ? { dropped: run.dropped } : {}),
      };
      const text = encodeFrame(frame);
      if (Buffer.byteLength(text, "utf8") <= TRACE_SPANS_FRAME_MAX_BYTES) {
        if (!this.#deps.sendText(text)) return; // not connected: keep them
        run.pending = run.pending.slice(batch.length);
        this.#buffered -= batch.length;
        run.dropped = 0;
        return;
      }
      if (batch.length === 1) {
        run.pending = run.pending.slice(1); // a single span that can never fit
        this.#buffered -= 1;
        run.dropped += 1;
        return;
      }
      batch = batch.slice(0, Math.ceil(batch.length / 2));
    }
  }
}
