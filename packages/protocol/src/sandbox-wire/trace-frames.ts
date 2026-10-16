import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import { spanIdSchema, traceparentSchema } from "../tracing.js";
import { SANDBOX_SMALL_FRAME_MAX_BYTES, SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * Sandbox spans relayed through the server (KOBE-274; ids in tracing.ts). CONTRACT, wire v1.
 *
 * The sandbox holds no collector endpoint and no collector credential. It records spans from Pi's
 * RPC events and sends them to the server as `trace.spans` frames over its existing WSS (the
 * connection its `kobe.sandbox-wire` session token authenticated); the server validates them,
 * re-attributes them and exports them with its own exporter, behind its content gate.
 *
 * Switch: hello capability {@link CAPABILITY_TRACE_SPANS}. The server sends `trace` on `run.start`
 * and `thread.compact` only to agents that list it, and only when its own tracing is on and the run
 * is sampled. The agent records and sends spans **only for runs whose start carried `trace`**:
 * tracing off means no `trace` field, so no span frames and no recording cost in the sandbox.
 * Steer and stop need no trace context of their own: the run's trace is fixed at its start, and
 * the server records its `run.steer` / `run.stop` command spans in that trace itself.
 *
 * What the sandbox sends (normative for kobe-sandbox-agent)
 * - Span names are closed ({@link SANDBOX_SPAN_NAMES}), each with its own strict attribute set
 *   (the schema is the allow-list): run, turn, tool call (name, call id, outcome), compaction and
 *   workspace sync. Token counts are NOT sent: the gateway's `model_gateway.request` is the meter
 *   (a second count on turn spans would double costs in Langfuse).
 * - Content (`kobe.tool.input` / `kobe.tool.output`, at most {@link SANDBOX_SPAN_CONTENT_MAX_CHARS}
 *   characters each) only when the run's `trace.capture_content` is true. The server's content
 *   gate drops them anyway when capture is off.
 * - `span_id`: random 16 hex digits per span. `parent_span_id`: the span id of the run's trace
 *   context (`trace.traceparent`) for the run span, else another span of the same run.
 * - Times: Unix epoch milliseconds (fractions allowed), `end_ms >= start_ms`, at most
 *   {@link SANDBOX_SPAN_MAX_DURATION_MS} apart. A span is sent once, when it ends; spans still open
 *   when Pi exits are ended then with status `error` (`error_type` `pi_exited`).
 * - Batching: at most {@link TRACE_SPANS_PER_FRAME_MAX} spans per frame, one frame per run per
 *   {@link TRACE_SPANS_FLUSH_INTERVAL_MS} at most, a frame never over
 *   {@link TRACE_SPANS_FRAME_MAX_BYTES} (the agent sizes it before sending and splits; a single span
 *   that cannot fit is dropped). Unsequenced, unacknowledged, never re-sent after a reconnect.
 * - Bounded memory, never blocking a run: the agent buffers at most
 *   {@link TRACE_SPANS_AGENT_BUFFER_MAX} ended spans across runs and drops new spans past that,
 *   counting them in the next frame's `dropped`. Span frames go out after every other queued frame.
 *
 * What the server does (normative for services/server)
 * - Lease: `run_id` / `thread_id` must be leased to the connection, as for every frame (a foreign
 *   run or thread is a `lease_violation`). A frame for a run of this connection that ended less
 *   than {@link TRACE_SPANS_LATE_GRACE_MS} ago is accepted (the run span ends just before the run
 *   goes terminal); later, or for a run started without `trace`, or from a connection that did not
 *   announce the capability, it is dropped silently (no `error` reply).
 * - Limits (server defaults, tunable without a wire change): at most
 *   {@link TRACE_SPANS_PER_RUN_MAX} spans per run and a per-connection rate of
 *   {@link TRACE_SPANS_FRAMES_PER_SECOND} frames per second (burst
 *   {@link TRACE_SPANS_FRAMES_BURST}); over either, frames are dropped and counted, never queued.
 *   Export goes through the batch processor's bounded queue: overload drops spans, never the run.
 * - Re-attribution: the trace id is `runTraceId(run_id)` of the leased run (the frame names none).
 *   A span whose `span_id` equals an id the server issued for the run (its root or a command span)
 *   is dropped, so a sandbox cannot shadow a server span. The server stamps `kobe.team_id`,
 *   `kobe.user_id`, `kobe.thread_id`, `kobe.run_id`, `kobe.sandbox_id`, `session.id` (thread) and
 *   `user.id` (member) from the connection and lease, sets the span status from `status` and
 *   `error.type` from `error_type`, adds the frame's allow-listed attributes, and nothing else.
 * - A frame that fails this schema is `malformed_frame`, as for any frame.
 */

export const CAPABILITY_TRACE_SPANS = "trace_spans";

/** Server → sandbox: a run's trace context, on `run.start.trace` and `thread.compact.trace`. */
export const wireTraceContextSchema = z.strictObject({
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
/** Most attributes any sandbox span may carry (the per-name schemas stay under it). */
export const SANDBOX_SPAN_MAX_ATTRIBUTES = 16;
/** Longest metadata string attribute (tool names are at most 256). */
export const SANDBOX_SPAN_ATTRIBUTE_MAX_CHARS = 256;
/** Longest content attribute; equals `MAX_CAPTURED_CHARS` of `@kobe/telemetry`. */
export const SANDBOX_SPAN_CONTENT_MAX_CHARS = 4096;
export const SANDBOX_SPAN_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
/** Upper bound of a frame's `dropped` counter. */
export const TRACE_SPANS_DROPPED_MAX = 1_000_000;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
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
    /** Pi's stop reason of the turn's assistant message (`stop`, `length`, `tool_use`, ...). */
    "kobe.stop_reason": code.optional(),
    "kobe.tool_calls": count.optional(),
  }),
  /** Pi `tool_execution_start` → `tool_execution_end`. */
  "sandbox.tool": z.strictObject({
    "kobe.tool.name": z.string().min(1).max(SANDBOX_SPAN_ATTRIBUTE_MAX_CHARS),
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

const time = z.number().finite().positive();
const spanFields = {
  span_id: spanIdSchema,
  parent_span_id: spanIdSchema,
  start_ms: time,
  end_ms: time,
  status: z.enum(["ok", "error"]),
  /** Error class only (never a message): `pi_exited`, `tool_error`, `model_error`, ... */
  error_type: code.optional(),
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
  .refine((s) => s.end_ms >= s.start_ms && s.end_ms - s.start_ms <= SANDBOX_SPAN_MAX_DURATION_MS, {
    message: "span times out of order or too long",
  })
  .refine((s) => s.span_id !== s.parent_span_id, { message: "span is its own parent" })
  .refine((s) => s.status === "error" || s.error_type === undefined, {
    message: "error_type needs status error",
  });
export type SandboxSpan = z.infer<typeof sandboxSpanSchema>;

/** Sandbox → server, behind capability {@link CAPABILITY_TRACE_SPANS}. A small frame. */
export const traceSpansFrameSchema = z.strictObject({
  v: z.literal(SANDBOX_WIRE_VERSION),
  type: z.literal("trace.spans"),
  run_id: uuidSchema,
  thread_id: uuidSchema,
  spans: z
    .array(sandboxSpanSchema)
    .min(1)
    .max(TRACE_SPANS_PER_FRAME_MAX)
    .refine((spans) => new Set(spans.map((s) => s.span_id)).size === spans.length, {
      message: "duplicate span_id in frame",
    }),
  /** Spans of this run the agent dropped since its last frame (buffer full). */
  dropped: z.number().int().nonnegative().max(TRACE_SPANS_DROPPED_MAX).optional(),
});
export type TraceSpansFrame = z.infer<typeof traceSpansFrameSchema>;
