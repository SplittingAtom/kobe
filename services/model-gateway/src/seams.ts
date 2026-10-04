import type { Logger } from "pino";
import type { RouteKind } from "./routes.js";
import type { UsageReading } from "./usage/meter.js";

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
  /** Input tokens the request may cost (its size / 4; 0 for a GET). */
  readonly inputEstimate?: number;
  /** The output cap the request asks for (`max_tokens` and kin), when it sets one. */
  readonly requestedOutput?: number | undefined;
}

export type GateDecision =
  | {
      readonly ok: true;
      /** Called once when the admitted call ends (e.g. to release an in-flight reservation). */
      readonly release?: () => void;
    }
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
  readonly startedAt: Date;
  readonly durationMs: number;
  /** Time to the upstream's response headers; undefined when it never answered. */
  readonly ttfbMs: number | undefined;
  /**
   * Tokens the call used, measured from the upstream response (KOBE-43): zero for an error answer,
   * undefined when the call was refused before reaching Bifrost or Bifrost never answered.
   */
  readonly usage: UsageReading | undefined;
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
