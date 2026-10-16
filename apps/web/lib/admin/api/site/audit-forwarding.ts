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
/** Same rules as the server's `redactForwardingError` (services/server/src/audit/forward/redact.ts). */
const URL_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/)(?:([^\s/?#]*)@)?([^\s/?#@)\]'",]+)([/?#][^\s)\]'",]*)?/gi;
const AUTH_CREDENTIAL = /\b(Bearer|bearer|Basic|basic)\s+([A-Za-z0-9._~+/-]+=*)/g;

function looksLikeCredential(token: string): boolean {
  if (token.length < 6) return false;
  return /[0-9+/=._~-]/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token.slice(1)));
}

/**
 * The server stores errors redacted and redacts again on read; this third pass keeps credentials
 * off the screen even for an older server: every URL keeps only scheme://host[:port] (userinfo up
 * to the last "@", path and query go) and bearer/basic credentials go.
 */
export function redactForwardingError(message: string): string {
  return message
    .replace(
      URL_PATTERN,
      (_m, scheme: string, userinfo: string | undefined, host: string, rest = "") =>
        `${scheme}${userinfo === undefined ? "" : `${REDACTED}@`}${host}${
          rest === "" || rest === "/" ? rest : `/${REDACTED}`
        }`,
    )
    .replace(AUTH_CREDENTIAL, (match, scheme: string, token: string) =>
      looksLikeCredential(token) ? `${scheme} ${REDACTED}` : match,
    );
}
