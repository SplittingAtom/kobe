import { z } from "zod";

/**
 * Run traces (KOBE-274). CONTRACT: the ids every component derives for a run's trace, the W3C
 * `traceparent` shape Kobe sends, and the session attributes Langfuse groups by. Browser-safe (no
 * hashing): every id here is a pure function of the run id, so the server, the model gateway and
 * the sandbox agent agree on them without a lookup and a sandbox can never choose them.
 *
 * One run is one trace
 * - Trace id = the run id's 32 hex digits ({@link runTraceId}). Steer, stop, a compaction (its own
 *   run, KOBE-212) and the server's title / follow-up calls for a run (KOBE-234: the server-call
 *   token's `run_id`) all land in a run's trace whichever HTTP request or replica caused them; a
 *   Langfuse score (KOBE-275) can name the trace from the run id alone.
 * - Root span `kobe.run` with span id {@link runRootSpanId}, recorded by the server replica that ends
 *   the run (start = run created, end = terminal). It links to the HTTP request span that created
 *   the run (a span link, not a parent: that request has its own trace).
 * - The server's `sandbox.command` spans for a run are children of the root; `run.start.trace` /
 *   `thread.compact.trace` hand the sandbox a `traceparent` naming the command span. The sandbox's
 *   spans come back as `trace.spans` frames (sandbox-wire/trace-frames.ts) and the server exports
 *   them under the run's trace id, never one the frame names (frames carry no trace id).
 * - The model gateway sets `model_gateway.request`'s trace id from the run it attributed (verified
 *   run token, KOBE-118; server-call token, KOBE-234), never from the caller: an incoming
 *   `traceparent` is used only for its parent span id, and only when its trace id equals
 *   {@link runTraceId} of that run; otherwise the parent is {@link runRootSpanId}.
 *
 * Sessions (ac-6): every span of a run (server, sandbox-relayed, gateway) carries
 * {@link TRACE_SESSION_ID_ATTRIBUTE} = the thread id and {@link TRACE_USER_ID_ATTRIBUTE} = the
 * member's user id (opaque uuid; never an email or a name). The server stamps them on relayed
 * spans from the connection's lease; the gateway takes them from the server (the run's row, read
 * with the run-token activity check, or the server-call token's claims), never from the sandbox.
 */

/** Langfuse (and OTel semconv) session attribute: the thread id. */
export const TRACE_SESSION_ID_ATTRIBUTE = "session.id";
/** Langfuse (and OTel semconv) user attribute: the member's user id (uuid only). */
export const TRACE_USER_ID_ATTRIBUTE = "user.id";
/** Name of a run's root span. */
export const RUN_ROOT_SPAN_NAME = "kobe.run";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

/** W3C trace id: 32 lowercase hex digits, not all zero. */
export const traceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .refine((id) => id !== ZERO_TRACE_ID, "trace id is all zero");
/** W3C span (parent) id: 16 lowercase hex digits, not all zero. */
export const spanIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .refine((id) => id !== ZERO_SPAN_ID, "span id is all zero");

function hexOf(runId: string): string {
  const hex = UUID.test(runId) ? runId.replaceAll("-", "") : ZERO_TRACE_ID;
  if (hex === ZERO_TRACE_ID) throw new Error("run id must be a lowercase, non-nil uuid");
  return hex;
}

/** The trace id of a run: its uuid's 32 hex digits. Throws for anything but a lowercase non-nil uuid. */
export function runTraceId(runId: string): string {
  return hexOf(runId);
}

/**
 * The span id of a run's root span `kobe.run`: the low 64 bits of the run id (random in a v4
 * uuid), or `0000000000000001` in the impossible case they are all zero.
 */
export function runRootSpanId(runId: string): string {
  const low = hexOf(runId).slice(16);
  return low === ZERO_SPAN_ID ? "0000000000000001" : low;
}

/** Sampled flag of W3C trace-flags. */
export const TRACE_FLAG_SAMPLED = 0x01;

/**
 * W3C `traceparent`, version `00` only: `00-<trace id>-<parent span id>-<flags>`. Kobe always sends
 * flags `01` (only sampled runs get a trace context); a receiver accepts any flags and treats an
 * unsampled one as "do not record".
 */
export const traceparentSchema = z
  .string()
  .regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
  .refine((tp) => {
    const [, trace, span] = tp.split("-");
    return trace !== ZERO_TRACE_ID && span !== ZERO_SPAN_ID;
  }, "traceparent has an all-zero id");

export interface Traceparent {
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly sampled: boolean;
}

/** Parses a `traceparent`; `undefined` for anything that is not a valid version-00 value. */
export function parseTraceparent(value: string): Traceparent | undefined {
  if (!traceparentSchema.safeParse(value).success) return undefined;
  const [, traceId, parentSpanId, flags] = value.split("-") as [string, string, string, string];
  return { traceId, parentSpanId, sampled: (parseInt(flags, 16) & TRACE_FLAG_SAMPLED) !== 0 };
}

export function formatTraceparent(traceId: string, parentSpanId: string, sampled = true): string {
  const out = `00-${traceId}-${parentSpanId}-${sampled ? "01" : "00"}`;
  if (!traceparentSchema.safeParse(out).success) throw new Error("invalid trace context");
  return out;
}
