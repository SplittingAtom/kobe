/**
 * Site console: audit forwarding health (`GET /v1/site/audit/forwarding`, site.audit.read;
 * KOBE-19, shown since KOBE-182). Responses arrive camelized.
 */
import { apiRequest, type ApiResult } from "../../../api/client";

export type ForwardDestination = "syslog" | "otlp";

/** `failing` from 5 failures in a row; `pending` before the first run. */
export type ForwardStatus = "ok" | "retrying" | "failing" | "pending";

export interface DestinationHealth {
  readonly destination: ForwardDestination;
  readonly status: ForwardStatus;
  /** Events recorded but not yet delivered; null before the first run. */
  readonly behind: number | null;
  readonly delivered?: number;
  readonly failures?: number;
  readonly nextAttemptAt?: string | null;
  readonly lastSuccessAt?: string | null;
  readonly lastErrorAt?: string | null;
  readonly lastError?: string | null;
}

export interface ForwardingHealth {
  /** False when no destination is configured. */
  readonly enabled: boolean;
  readonly head: number;
  readonly destinations: readonly DestinationHealth[];
}

export function getAuditForwarding(): Promise<ApiResult<ForwardingHealth>> {
  return apiRequest("/v1/site/audit/forwarding");
}

const REDACTED = "[redacted]";

/**
 * The server stores errors redacted; this second pass keeps credentials off the screen even for an
 * older server or an error it did not foresee: URL userinfo, query strings, bearer/basic tokens.
 */
export function redactForwardingError(message: string): string {
  return message
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, `$1${REDACTED}@`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, `$1?${REDACTED}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`);
}
