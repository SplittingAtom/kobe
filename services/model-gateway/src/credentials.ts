import type { IncomingHttpHeaders } from "node:http";

/**
 * Where model SDKs put their API key, which in a sandbox is the `kobe.model-gateway` session token
 * (KOBE-41 configures Pi so): OpenAI `Authorization: Bearer`, Anthropic `x-api-key`, Gemini
 * `x-goog-api-key` or `?key=`, Azure-style `api-key`. Every one of them is removed before the call
 * reaches Bifrost, which would otherwise read them as credentials of its own.
 */
export const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "api-key"];

export type Credential =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: "missing" | "malformed" };

const MAX_TOKEN = 4096;

function one(value: string | string[] | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return null;
  return value.trim();
}

export function extractCredential(
  headers: IncomingHttpHeaders,
  search: URLSearchParams,
): Credential {
  const found = new Set<string>();
  for (const name of CREDENTIAL_HEADERS) {
    const raw = one(headers[name]);
    if (raw === null) return { ok: false, reason: "malformed" };
    if (raw === undefined || raw === "") continue;
    if (name === "authorization") {
      const match = /^Bearer\s+(\S+)$/i.exec(raw);
      if (!match?.[1]) return { ok: false, reason: "malformed" };
      found.add(match[1]);
    } else {
      found.add(raw);
    }
  }
  const keys = search.getAll("key");
  if (keys.length > 1) return { ok: false, reason: "malformed" };
  if (keys[0]) found.add(keys[0]);
  if (found.size === 0) return { ok: false, reason: "missing" };
  // Two different credentials in one request: ambiguous, refused.
  if (found.size > 1) return { ok: false, reason: "malformed" };
  const [token] = found;
  if (!token || token.length > MAX_TOKEN) return { ok: false, reason: "malformed" };
  return { ok: true, token };
}
