import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import { spanIdSchema, traceparentSchema } from "../tracing.js";
import { SANDBOX_SMALL_FRAME_MAX_BYTES, SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * Sandbox spans relayed through the server (KOBE-274; ids, remapping and the listener rule in
 * tracing.ts). CONTRACT, wire v1.
 *
 * The sandbox holds no collector endpoint and no collector credential. It records spans from Pi's
 * RPC events and sends them to the server as `trace.spans` frames over its existing WSS (the
 * connection its `kobe.sandbox-wire` session token authenticated); the server validates them,
 * re-attributes them and exports them with its own exporter, behind its content gate.
 *
 * Switch and versioning: hello capability {@link CAPABILITY_TRACE_SPANS}. The server sends `trace`
 * on `run.start` and `thread.compact` only to agents that list it, and only when its own tracing is
 * on, it holds the span remapping key and the run is sampled. The agent records and sends spans
 * **only for runs whose start carried `trace`**: tracing off means no `trace` field, so no span
 * frames and no recording cost in the sandbox. Steer and stop carry no trace context: the run's
 * trace is fixed at its start and the server records its steer / stop command spans in it. The
 * span set (names and attributes) is versioned by the capability, not by `v`: a new span name or
 * attribute is a new capability string (`trace_spans_2`), used only once the server acknowledges
 * it. `trace` is decoded loosely (unknown keys are dropped), so a new trace-context field never
 * fails a run on an older agent; tracing must never fail a run.
 *
 * What the sandbox sends (normative for kobe-sandbox-agent)
 * - Span names are closed ({@link SANDBOX_SPAN_NAMES}), each with its own strict attribute set
 *   ({@link SANDBOX_SPAN_ATTRIBUTES}, the allow-list): run, turn, tool call (call id and outcome;
 *   the tool's name comes from the server's own decision record), compaction and workspace sync.
 *   Every code is a closed enum; a value the agent cannot map is `other`. Token counts are NOT
 *   sent: the gateway's `model_gateway.request` is the meter (a second count would double costs).
 * - Content (`kobe.tool.input` / `kobe.tool.output`, at most {@link SANDBOX_SPAN_CONTENT_MAX_CHARS}
 *   characters each) only when the run's `trace.capture_content` is true.
 * - `span_id`: random 16 hex digits per span, unique within the run. `parent_span_id`: the run
 *   span's (and a `thread.compact` compaction span's) is the span id of `trace.traceparent`; every
 *   other span's is another span of the same run.
 * - Times: Unix epoch milliseconds (fractions allowed), `end_ms >= start_ms`. A span is sent once,
 *   when it ends; spans still open when Pi exits are ended then with `error_type` `pi_exited`.
 * - Batching: at most {@link TRACE_SPANS_PER_FRAME_MAX} spans per frame, at most one frame per run
 *   per {@link TRACE_SPANS_FLUSH_INTERVAL_MS}, a frame never over {@link TRACE_SPANS_FRAME_MAX_BYTES}
 *   (the agent sizes it before sending and splits; a single span that cannot fit is dropped).
 *   Unsequenced, unacknowledged, never re-sent.
 * - Bounded memory, never blocking a run: at most {@link TRACE_SPANS_AGENT_BUFFER_MAX} ended spans
 *   buffered across runs; past that new spans are dropped and counted in the next frame's
 *   `dropped`. The agent discards a run's buffered spans when `hello.ack` does not list the run
 *   (after a reconnect), and stops sending a run's spans {@link TRACE_SPANS_AGENT_SEND_AFTER_END_MS}
 *   after the run ended (below the server's grace).
 *
 * What the server does (normative for services/server)
 * - Before parsing spans (cheap checks first): the envelope must decode (`v`, `type`, ids, a
 *   1..{@link TRACE_SPANS_PER_FRAME_MAX} array); `run_id` / `thread_id` must belong to this
 *   connection. A run this connection never held is a `lease_violation`, as for every frame. A run
 *   it held that ended (kept for at least {@link TRACE_SPANS_LATE_GRACE_MS} whatever the ended-lease
 *   count cap), a run started without `trace`, a connection without the capability, or a frame over
 *   the rate: dropped and counted, never answered with `error`, never closing the connection.
 * - Spans are parsed one by one ({@link parseSandboxSpan}): an invalid span is dropped and counted,
 *   the rest of the frame is kept (also covers a rolled-back server older than its agents).
 * - Limits (server defaults, tunable without a wire change): at most
 *   {@link TRACE_SPANS_PER_RUN_MAX} spans per run; per connection
 *   {@link TRACE_SPANS_FRAMES_PER_SECOND} frames per second (burst {@link TRACE_SPANS_FRAMES_BURST});
 *   per replica a relayed-span budget with a fair share per team; relayed spans have their own
 *   bounded export queue, so they never evict or delay the server's own spans. Every drop (agent
 *   `dropped`, rate, run cap, duplicate, invalid, clamp, cycle, queue) is counted in a metric and
 *   on the run's `kobe.run` root ({@link TRACE_DROPPED_ATTRIBUTE}).
 * - Re-attribution: trace id = `runTraceId(run_id)`; span and parent ids remapped with
 *   `mapSandboxSpanId`, except a parent equal to a command span id the server issued for the run,
 *   which is kept. A span id seen before in the run is a duplicate and dropped (seen-set of at most
 *   {@link TRACE_SPANS_PER_RUN_MAX}). Parents: a `sandbox.run` whose parent is not the run's
 *   command span is reparented there; a span that would close a cycle is dropped; a chain deeper
 *   than {@link TRACE_SPAN_MAX_DEPTH} is reparented to the run span; a parent never seen by the
 *   time the run ends stays an orphan in the run's trace (accepted).
 * - Times are clamped to the run window `[run started − skew, min(now, run ended + grace) + skew]`
 *   ({@link TRACE_SPAN_CLOCK_SKEW_MS}); a span whose end is still before its start is dropped.
 * - Stamps, never from the frame: `kobe.team_id`, `kobe.user_id`, `kobe.thread_id` (the lease's),
 *   `kobe.run_id`, `kobe.sandbox_id`, `session.id`, `user.id` (tracing.ts); `kobe.tool.name` from
 *   its policy decision for (`run_id`, `kobe.tool.call_id`), else `unknown` with the call id
 *   dropped; span status and `error.type` from `error_type`. Content keys are stripped at intake
 *   when capture is off, and the exporter's content gate drops them again.
 * - Accepted: a sandbox holding two runs can move spans between them (same team, user, sandbox).
 */
export const CAPABILITY_TRACE_SPANS = "trace_spans";

/**
 * Server → sandbox: a run's trace context, on `run.start.trace` and `thread.compact.trace`. Loose:
 * unknown keys are dropped, so a future field never fails a run on an older agent.
 */
export const wireTraceContextSchema = z.object({
  /** W3C `traceparent`: trace id = `runTraceId(run_id)`, parent = the command's span id, flags 01. */
  traceparent: traceparentSchema,
  /** Site setting `telemetry.captureContent`: may the agent send content attributes. */
  capture_content: z.boolean(),
});
export type WireTraceContext = z.infer<typeof wireTraceContextSchema>;

export const TRACE_SPANS_PER_FRAME_MAX = 64;
/** A `trace.spans` frame has no own size entry: it is a small frame. */
export const TRACE_SPANS_FRAME_MAX_BYTES = SANDBOX_SMALL_FRAME_MAX_BYTES;
export const TRACE_SPANS_FLUSH_INTERVAL_MS = 2_000;
export const TRACE_SPANS_AGENT_BUFFER_MAX = 512;
export const TRACE_SPANS_PER_RUN_MAX = 2_048;
export const TRACE_SPANS_FRAMES_PER_SECOND = 10;
export const TRACE_SPANS_FRAMES_BURST = 20;
export const TRACE_SPANS_LATE_GRACE_MS = 30_000;
/** The agent's cut-off after a run ended; below {@link TRACE_SPANS_LATE_GRACE_MS}. */
export const TRACE_SPANS_AGENT_SEND_AFTER_END_MS = 20_000;
/** Clock skew tolerated around the run window when the server clamps span times. */
export const TRACE_SPAN_CLOCK_SKEW_MS = 60_000;
/** Deepest parent chain the server follows; deeper spans are reparented to the run span. */
export const TRACE_SPAN_MAX_DEPTH = 8;
/** Most attributes any sandbox span may carry (the per-name schemas stay under it). */
export const SANDBOX_SPAN_MAX_ATTRIBUTES = 16;
/** Longest content attribute; equals `MAX_CAPTURED_CHARS` of `@kobe/telemetry`. */
export const SANDBOX_SPAN_CONTENT_MAX_CHARS = 4096;
/** Plausible epoch-millisecond range of a span time (2001 .. 2286); the server clamps further. */
export const SANDBOX_SPAN_TIME_MIN_MS = 1e12;
export const SANDBOX_SPAN_TIME_MAX_MS = 1e13;

/** `error_type` values (closed; `other` for anything unmapped). */
export const SANDBOX_SPAN_ERROR_TYPES = [
  "pi_exited",
  "tool_error",
  "model_error",
  "aborted",
  "blocked",
  "sync_failed",
  "internal",
  "other",
] as const;
/** Pi's stop reason of a turn's assistant message, snake-cased (`toolUse` → `tool_use`). */
export const SANDBOX_TURN_STOP_REASONS = [
  "stop",
  "length",
  "tool_use",
  "error",
  "aborted",
  "other",
] as const;
/** Upper bound of a frame's `dropped` counter. */
export const TRACE_SPANS_DROPPED_MAX = 1_000_000;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const content = z.string().max(SANDBOX_SPAN_CONTENT_MAX_CHARS);

/** Attribute allow-list per span name. Keys are OTel attribute names as exported. */
export const SANDBOX_SPAN_ATTRIBUTES = {
  /** Pi `agent_start` → `agent_end` (or the run's stop). */
  "sandbox.run": z.strictObject({
    "kobe.run.outcome": z.enum(["completed", "aborted", "failed"]).optional(),
    "kobe.turns": count.optional(),
  }),
  /** Pi `turn_start` → `turn_end`: one model step and its tool calls. */
  "sandbox.turn": z.strictObject({
    "kobe.turn.index": count,
    "kobe.stop_reason": z.enum(SANDBOX_TURN_STOP_REASONS).optional(),
    "kobe.tool_calls": count.optional(),
  }),
  /** Pi `tool_execution_start` → `tool_execution_end`. */
  "sandbox.tool": z.strictObject({
    /** The server keeps it only when it decided this call for the run, and adds the tool's name. */
    "kobe.tool.call_id": idSchema,
    /** `blocked`: kobe-policy blocked the call (deny or approval refused). */
    "kobe.tool.outcome": z.enum(["ok", "error", "blocked", "aborted"]),
    "kobe.tool.input": content.optional(),
    "kobe.tool.output": content.optional(),
  }),
  /** Pi compaction: a `thread.compact` command or an automatic one inside a run. */
  "sandbox.compaction": z.strictObject({
    "kobe.compaction.trigger": z.enum(["command", "threshold", "overflow"]),
    "kobe.compaction.tokens_before": count.optional(),
  }),
  /** One workspace sync push or pull during the run (workspace-sync.ts). */
  "sandbox.workspace_sync": z.strictObject({
    "kobe.sync.direction": z.enum(["push", "pull"]),
    "kobe.sync.files": count.optional(),
    "kobe.sync.bytes": count.optional(),
  }),
} as const;

export const SANDBOX_SPAN_NAMES = Object.keys(SANDBOX_SPAN_ATTRIBUTES) as SandboxSpanName[];
export type SandboxSpanName = keyof typeof SANDBOX_SPAN_ATTRIBUTES;

/** Attribute keys that carry content (exported only with `captureContent`). */
export const SANDBOX_SPAN_CONTENT_KEYS = ["kobe.tool.input", "kobe.tool.output"] as const;

const time = z.number().min(SANDBOX_SPAN_TIME_MIN_MS).max(SANDBOX_SPAN_TIME_MAX_MS);
const spanFields = {
  span_id: spanIdSchema,
  parent_span_id: spanIdSchema,
  start_ms: time,
  end_ms: time,
  status: z.enum(["ok", "error"]),
  /** Error class only (never a message). */
  error_type: z.enum(SANDBOX_SPAN_ERROR_TYPES).optional(),
};

function spanOf<N extends SandboxSpanName>(name: N) {
  return z.strictObject({
    ...spanFields,
    name: z.literal(name),
    attributes: SANDBOX_SPAN_ATTRIBUTES[name],
  });
}

export const sandboxSpanSchema = z
  .discriminatedUnion("name", [
    spanOf("sandbox.run"),
    spanOf("sandbox.turn"),
    spanOf("sandbox.tool"),
    spanOf("sandbox.compaction"),
    spanOf("sandbox.workspace_sync"),
  ])
  .refine((s) => s.end_ms >= s.start_ms, { message: "span ends before it starts" })
  .refine((s) => s.span_id !== s.parent_span_id, { message: "span is its own parent" })
  .refine((s) => s.status === "error" || s.error_type === undefined, {
    message: "error_type needs status error",
  });
export type SandboxSpan = z.infer<typeof sandboxSpanSchema>;

/** One span as the server parses it, on its own (an invalid span is dropped, not the frame). */
export function parseSandboxSpan(value: unknown): SandboxSpan | undefined {
  const parsed = sandboxSpanSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Sandbox → server, behind capability {@link CAPABILITY_TRACE_SPANS}. A small frame. The envelope is
 * strict; `spans` are parsed one by one with {@link parseSandboxSpan}.
 */
export const traceSpansFrameSchema = z.strictObject({
  v: z.literal(SANDBOX_WIRE_VERSION),
  type: z.literal("trace.spans"),
  run_id: uuidSchema,
  thread_id: uuidSchema,
  spans: z.array(z.unknown()).min(1).max(TRACE_SPANS_PER_FRAME_MAX),
  /** Spans of this run the agent dropped since its last frame (buffer full, too large). */
  dropped: z.number().int().nonnegative().max(TRACE_SPANS_DROPPED_MAX).optional(),
});
export type TraceSpansFrame = z.infer<typeof traceSpansFrameSchema>;
