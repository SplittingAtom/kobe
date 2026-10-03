import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

/**
 * Request headers forwarded to Bifrost: an allowlist. Notably never a credential, a cookie, or any
 * `x-bf-*` header (Bifrost's own controls: virtual key, direct provider keys, extra upstream
 * headers, raw request/response echo, logging switches).
 */
const FORWARD = new Set([
  "content-type",
  "accept",
  "user-agent",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "x-goog-api-client",
]);
const FORWARD_PREFIX = "x-stainless-"; // SDK telemetry (runtime, version, retry count)

export function forwardRequestHeaders(
  incoming: IncomingHttpHeaders,
  virtualKey: string,
  contentLength: number,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (FORWARD.has(name) || name.startsWith(FORWARD_PREFIX)) out[name] = value;
  }
  out["x-bf-vk"] = virtualKey;
  out["content-length"] = String(contentLength);
  return out;
}

/** Response headers not passed back: hop-by-hop, cookies, and Bifrost's own `x-bf-*` metadata. */
const DROP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-connection",
  "set-cookie",
]);

export function forwardResponseHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || DROP.has(name) || name.startsWith("x-bf-")) continue;
    out[name] = value;
  }
  return out;
}
