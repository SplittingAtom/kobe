import { KOBE_MODEL_ERROR_PREFIX, type ModelRunErrorCode } from "./protocol.js";

/**
 * What a failed model request means (KOBE-41): the gateway's error code (KOBE-40 `sendError`:
 * OpenAI `error.code`, Anthropic `error.type`, Gemini `error.status`) and HTTP status, read from
 * the response Pi's adapter saw (`onResponse`) and from the error text the adapter composed
 * (`<status>: <body>` for the OpenAI SDK; the body is folded into the message for Anthropic and
 * Gemini). Everything here is untrusted text from the network; only the derived code travels on.
 */
export interface Failure {
  readonly status: number | undefined;
  /** The gateway's (or Bifrost's) error code, when the body named one. */
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;
}

/** Gateway codes that mean "try again shortly" even when the status alone would not. */
const TRANSIENT_CODES = new Set([
  "transport_failure",
  "model_access_pending",
  "model_access_unavailable",
  "model_gateway_resyncing",
  "model_gateway_unavailable",
  "too_many_concurrent_calls",
  "too_many_bytes_in_flight",
  "rate_limited",
]);
const RETRY_STATUSES = new Set([429, 502, 503, 504, 529]);
/** No HTTP answer at all (the shim restarting, a reset): worth a retry like a 503. */
const TRANSPORT_FAILURE =
  /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|fetch failed|socket hang up|other side closed|network ?error/i;
/** Codes meaning the run's model is not allowed for this team (the shim's or Bifrost's). */
const NOT_ENABLED_CODES = new Set(["model_not_enabled", "model_blocked", "provider_blocked"]);
const REVOKED_CODES = new Set(["session_revoked", "invalid_session_token"]);
/** A used-up budget (KOBE-42): the shim's 402, or Bifrost's own budget refusal. */
const BUDGET_CODES = new Set(["budget_exhausted", "policy_budget_exceeded"]);

export const MAX_RETRY_AFTER_MS = 30_000;

function codeInBody(text: string): string | undefined {
  // The first JSON object in the message is the error body (OpenAI: `{"message","type","code"}`,
  // Anthropic: `{"type":"error","error":{"type",...}}`, Gemini: `{"error":{"code","status"}}`).
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
  } catch {
    return undefined;
  }
  const seen = new Set<unknown>();
  const find = (value: unknown, depth: number): string | undefined => {
    if (depth > 3 || typeof value !== "object" || value === null || seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    // Gemini errors carry Kobe's code as an ErrorInfo `reason` (the shim's sendError).
    for (const key of ["code", "type", "reason"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(candidate)) {
        if (candidate !== "error") return candidate;
      }
    }
    for (const nested of Object.values(record)) {
      const found = find(nested, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return find(parsed, 0);
}

function statusInMessage(text: string): number | undefined {
  // OpenAI SDK: `<status>: <body>`; Anthropic SDK: `<status> <body>`.
  const lead = /^(\d{3})[: ]/.exec(text);
  if (lead) return Number(lead[1]);
  const inBody = /"code"\s*:\s*(\d{3})\b/.exec(text);
  return inBody ? Number(inBody[1]) : undefined;
}

export function classifyFailure(
  errorMessage: string | undefined,
  response: { readonly status: number; readonly headers: Record<string, string> } | undefined,
): Failure {
  const text = errorMessage ?? "";
  const status = response?.status ?? statusInMessage(text);
  const retryAfter = response?.headers["retry-after"];
  const seconds = retryAfter === undefined ? NaN : Number(retryAfter);
  const code =
    codeInBody(text) ??
    (status === undefined && TRANSPORT_FAILURE.test(text) ? "transport_failure" : undefined);
  return {
    status,
    code,
    retryAfterMs:
      Number.isFinite(seconds) && seconds >= 0
        ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
        : undefined,
  };
}

export function isTransient(failure: Failure): boolean {
  return (
    (failure.status !== undefined && RETRY_STATUSES.has(failure.status)) ||
    (failure.code !== undefined && TRANSIENT_CODES.has(failure.code))
  );
}

/** A 401: the token may have just rotated (re-read the file once) or the session is revoked. */
export function isUnauthorized(failure: Failure): boolean {
  return failure.status === 401 || (failure.code !== undefined && REVOKED_CODES.has(failure.code));
}

/** The run error code for a failure that is not retried (any more). */
export function runErrorCode(failure: Failure): ModelRunErrorCode {
  // Only Kobe's own refusal or Bifrost's budget: a provider's own 402 (its billing) is an error.
  if (failure.code !== undefined && BUDGET_CODES.has(failure.code)) {
    return "model_budget_exhausted";
  }
  if (failure.code !== undefined && NOT_ENABLED_CODES.has(failure.code)) return "model_not_enabled";
  if (failure.status === 403 && failure.code === undefined) return "model_not_enabled";
  if (isUnauthorized(failure)) return "model_session_revoked";
  if (failure.status === 429 || failure.code === "rate_limited") return "model_throttled";
  if (isTransient(failure)) return "model_unavailable";
  return "model_error";
}

/**
 * The `errorMessage` the server reads (`parseKobeModelError`). Built from fixed parts only: it
 * must not read as transient to Pi's own auto-retry (`isRetryableAssistantError` matches status
 * numbers and words like "rate limit", "overloaded"), and the gateway's code is network text
 * (`rate_limited` would match) — it goes to stderr (`warn`) per attempt instead.
 */
export function kobeErrorMessage(
  code: ModelRunErrorCode,
  _failure: Failure,
  attempts: number,
): string {
  return `${KOBE_MODEL_ERROR_PREFIX}${code}: gave up after ${attempts} attempt${attempts === 1 ? "" : "s"}`;
}
