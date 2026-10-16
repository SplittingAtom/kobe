import { z } from "zod";

/**
 * Run traces (KOBE-274). CONTRACT: the ids every component derives for a run's trace, the W3C
 * `traceparent` shape Kobe sends, and the session attributes Langfuse groups by. Browser-safe (no
 * hashing): the trace id and root span id are pure functions of the run id, so the server, the
 * model gateway and the sandbox agent agree on them without a lookup. They are **predictable**
 * (anyone who sees a run id knows its trace id), so trust never comes from a trace id: see the
 * listener rule below.
 *
 * One run is one trace
 * - Trace id = the run id's 32 hex digits ({@link runTraceId}). Steer, stop and the server's title
 *   / follow-up calls for a run (KOBE-234: the server-call token's `run_id`) land in the run's
 *   trace whichever HTTP request or replica caused them; a Langfuse score (KOBE-275) can name the
 *   trace from the run id alone. A compaction is its own run (KOBE-212), so it is its own trace,
 *   in the same session.
 * - Root span `kobe.run` with span id {@link runRootSpanId}, recorded by the server replica that ends
 *   the run (start = run created, end = terminal), with {@link TRACE_DROPPED_ATTRIBUTE} when sandbox
 *   spans were dropped. It links to the HTTP request span that created the run (a span link, not a
 *   parent: that request has its own trace).
 * - The server's `sandbox.command` spans for a run are children of the root; `run.start.trace` /
 *   `thread.compact.trace` hand the sandbox a `traceparent` naming the command span. The sandbox's
 *   spans come back as `trace.spans` frames (sandbox-wire/trace-frames.ts); the server exports them
 *   under the run's trace id (frames carry none) with **remapped span ids**: exported id =
 *   `mapSandboxSpanId` (`@kobe/protocol/node`) = the first 64 bits of
 *   HMAC-SHA256(`k_trace`, run id ‖ sandbox span id), `k_trace` = HKDF-SHA256 of the model-gateway
 *   session key with info {@link TRACE_SPAN_KDF_INFO}. A sandbox therefore never produces an
 *   exported span id, so it cannot overwrite another span in a backend that upserts by id.
 *
 * Listener rule (normative). No listener a sandbox can reach (model gateway, MCP proxy, egress
 * proxy, the server's sandbox WSS upgrade) joins a caller's trace through generic `traceparent`
 * propagation. The model gateway starts `model_gateway.request` only **after** it attributed the
 * call to a run (verified run token, KOBE-118; server-call token, KOBE-234; the leased advisory run
 * id), with trace id = {@link runTraceId} of that run and parent = the incoming `traceparent`'s
 * parent id mapped through `mapSandboxSpanId` when its trace id equals that run's, else
 * {@link runRootSpanId} (a server call's parent is always the root). No attributed run: a fresh
 * trace, the incoming `traceparent` ignored. The other sandbox-reachable listeners always start a
 * fresh trace. A sandbox can thus place spans only in the traces of runs leased to it.
 *
 * Sessions (ac-6): every span of a run (server, sandbox-relayed, gateway) carries
 * {@link TRACE_SESSION_ID_ATTRIBUTE} = the thread id and {@link TRACE_USER_ID_ATTRIBUTE} = the
 * thread's owner (`threads.owner_user_id`; opaque uuid, never an email or a name), the same source
 * everywhere so a session never shows two users. The server stamps them on relayed spans from the
 * connection's lease (never from the frame); the model gateway reads them with the run-token
 * activity check (one cached query; on the legacy advisory path, the leased run's row) or from the
 * server-call token's `thread_id` / `user_id` claims (which the server mints from the same row).
 * Never from the sandbox.
 */

/** Langfuse (and OTel semconv) session attribute: the thread id. */
export const TRACE_SESSION_ID_ATTRIBUTE = "session.id";
/** Langfuse (and OTel semconv) user attribute: the member's user id (uuid only). */
export const TRACE_USER_ID_ATTRIBUTE = "user.id";
/** Name of a run's root span. */
export const RUN_ROOT_SPAN_NAME = "kobe.run";
/** On the `kobe.run` root: sandbox spans dropped (agent buffer plus every server-side drop). */
export const TRACE_DROPPED_ATTRIBUTE = "kobe.trace.sandbox_spans_dropped";
/** HKDF info of `k_trace`, the key that remaps sandbox span ids (`@kobe/protocol/node`). */
export const TRACE_SPAN_KDF_INFO = "kobe/trace-span/v1";
export const TRACE_SPAN_KEY_BYTES = 32;

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
