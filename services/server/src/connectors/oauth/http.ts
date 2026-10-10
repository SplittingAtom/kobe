import { checkConnectorUrl, type ConnectorUrlPolicy } from "../url-policy.js";

/** A refusal with a fixed code; messages never carry URLs, tokens or response bodies. */
export type OauthFailureCode =
  | "oauth_unsupported"
  | "oauth_unreachable"
  | "invalid_state"
  | "iss_mismatch"
  | "token_exchange_failed"
  | "registration_failed";

export class OauthError extends Error {
  constructor(readonly code: OauthFailureCode) {
    super(code);
    this.name = "OauthError";
  }
}

export interface OauthIo {
  readonly policy: ConnectorUrlPolicy;
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
}

export const MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;

async function readCapped(res: Response): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One outbound request to a discovery, registration or token URL. The URL passes the connector
 * address policy first (no private or metadata addresses), redirects are refused, time and size
 * are capped. Returns status and parsed JSON (undefined when the body is not JSON); failures
 * throw {@link OauthError} with a fixed code, never the cause.
 */
export async function oauthRequest(
  io: OauthIo,
  rawUrl: string,
  init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string },
  failure: OauthFailureCode,
): Promise<{ status: number; json: unknown }> {
  const checked = await checkConnectorUrl(rawUrl, io.policy);
  if (!checked.ok) throw new OauthError("oauth_unsupported");
  try {
    const res = await io.fetch(checked.url, {
      method: init.method ?? "GET",
      headers: { accept: "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: "error",
      signal: AbortSignal.timeout(io.timeoutMs),
    });
    const text = await readCapped(res);
    if (text === undefined) throw new OauthError(failure);
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (error) {
    throw error instanceof OauthError ? error : new OauthError("oauth_unreachable");
  }
}
