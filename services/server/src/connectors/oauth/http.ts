import http from "node:http";
import https from "node:https";
import net from "node:net";
import { AddressPolicy } from "@kobe/address-policy";
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
  readonly timeoutMs: number;
}

export const MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Connects to the address the policy approved, not to whatever the name resolves to later: the
 * socket's own DNS lookup resolves the host, checks every address against the connector address
 * policy and hands the socket one checked address. The URL keeps its hostname, so Host and TLS
 * SNI/certificate checks are unchanged. A name that re-resolves to a private address after the
 * registration-time check (DNS rebinding) is refused here.
 */
function pinnedLookup(policy: ConnectorUrlPolicy): net.LookupFunction {
  const addresses = new AddressPolicy({
    allowedInternal: policy.allowedInternalCidrs,
    extraDenied: policy.deniedCidrs,
  });
  return (hostname, options, callback) => {
    const done = (found: readonly string[]) => {
      const usable = found.filter((a) => net.isIP(a) !== 0);
      if (usable.length === 0 || addresses.checkAll(usable) !== "allowed") {
        callback(new Error("address not allowed"), "", 0);
        return;
      }
      const ordered = [...usable].sort((a, b) => net.isIP(a) - net.isIP(b));
      const family = (a: string) => net.isIP(a);
      if (options.all) {
        (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
          null,
          ordered.map((address) => ({ address, family: family(address) })),
        );
      } else {
        const first = ordered[0] ?? "";
        callback(null, first, family(first));
      }
    };
    if (net.isIP(hostname) !== 0) return done([hostname]);
    policy.resolve(hostname).then(done, (err: unknown) => callback(err as Error, "", 0));
  };
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string | undefined;
}

function rawRequest(
  url: URL,
  io: OauthIo,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<RawResponse> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: init.method,
        headers: init.headers,
        lookup: pinnedLookup(io.policy),
        timeout: io.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Redirects are never followed: a hop could point at an address nobody checked.
        if (status >= 300 && status < 400) {
          res.destroy();
          reject(new OauthError("oauth_unreachable"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            res.destroy();
            resolve({ status, headers: res.headers, text: undefined });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({ status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    // `timeout` is idle time; the deadline bounds the whole exchange.
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), io.timeoutMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(init.body);
  });
}

/**
 * One outbound request to a discovery, registration or token URL. The URL passes the connector
 * policy first, the connection is pinned to a checked address, redirects are refused, time and
 * size are capped. Returns status, a `WWW-Authenticate` header if any, and parsed JSON (undefined
 * when the body is not JSON); failures throw {@link OauthError} with a fixed code, never the cause.
 */
export async function oauthRequest(
  io: OauthIo,
  rawUrl: string,
  init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string },
  failure: OauthFailureCode,
): Promise<{ status: number; json: unknown; wwwAuthenticate: string | undefined }> {
  const checked = await checkConnectorUrl(rawUrl, io.policy);
  if (!checked.ok) throw new OauthError("oauth_unsupported");
  try {
    const res = await rawRequest(new URL(checked.url), io, {
      method: init.method ?? "GET",
      headers: { accept: "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (res.text === undefined) throw new OauthError(failure);
    let json: unknown;
    try {
      json = res.text === "" ? undefined : JSON.parse(res.text);
    } catch {
      json = undefined;
    }
    const www = res.headers["www-authenticate"];
    return { status: res.status, json, wwwAuthenticate: Array.isArray(www) ? www[0] : www };
  } catch (error) {
    throw error instanceof OauthError ? error : new OauthError("oauth_unreachable");
  }
}
