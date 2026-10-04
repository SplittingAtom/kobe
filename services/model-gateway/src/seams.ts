import type { Logger } from "pino";
import type { RouteKind } from "./routes.js";

/**
 * Seams for the tickets that build on the gateway (KOBE-40 leaves them open):
 *
 * - {@link CallGate} (KOBE-42 budgets/rate limits): consulted before a call is forwarded. Bifrost
 *   enforces the dollar budgets and rate limits on its own hierarchy (customer/team/virtual key);
 *   a gate lets Kobe refuse new calls itself (e.g. a run already `budget_stopped`). Calls already
 *   in flight are never cut, so the current model step always finishes (D30).
 * - {@link UsageSink} (KOBE-43 run_usage reconciliation): one record per call, attributed to
 *   (team, user, sandbox, run). The authoritative usage comes from Pi over the wire (D30); this is
 *   the gateway's own view (status, bytes, model, Bifrost's error type).
 */
export interface CallContext {
  readonly teamId: string;
  readonly userId: string;
  readonly sandboxId: string;
  /** From `x-kobe-run-id`, verified leased to this sandbox; undefined when not sent. */
  readonly runId: string | undefined;
  readonly route: RouteKind;
  readonly path: string;
  /** The model the request names (body `model`, or Gemini's path), when it does. */
  readonly model: string | undefined;
}

export type GateDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 402 | 403 | 429 | 503;
      readonly code: string;
      readonly message: string;
      readonly retryAfterSeconds?: number;
    };

export interface CallGate {
  admit(call: CallContext): Promise<GateDecision>;
}

export const OPEN_GATE: CallGate = { admit: async () => ({ ok: true }) };

export interface CallRecord extends CallContext {
  readonly status: number;
  readonly durationMs: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  /** Bifrost's error `type` for refused calls (e.g. budget or rate-limit errors), if any. */
  readonly errorType: string | undefined;
  /** The client went away before the response finished. */
  readonly aborted: boolean;
}

export interface UsageSink {
  record(call: CallRecord): void;
}

/** Default sink: one JSON log line per call (metadata only, never content). */
export function logSink(logger: Logger): UsageSink {
  return {
    record: (call) => logger.info({ call }, "model call"),
  };
}
