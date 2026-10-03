import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { AddressPolicy } from "./address-policy.js";
import type { UpstreamPolicy } from "./config.js";

/**
 * The proxy's MCP client towards remote servers (D27: Streamable HTTP only, no stdio). One short
 * session per call: `initialize` → `notifications/initialized` → `tools/call` → `DELETE` session.
 * Answers may be JSON or an SSE stream (the response with our id is taken; server notifications and
 * requests on the stream are ignored: the proxy declares no client capabilities).
 *
 * Where it may connect is checked here, not by the URL's say-so: the scheme (HTTPS unless
 * explicitly allowed), the port, and every address the host resolves to (the egress proxy's
 * ranges: private, loopback, link-local/metadata, …, unless an operator allowed them). The proxy
 * connects only to an address it checked (rebinding-safe) and never follows redirects. Responses
 * are capped in size and time.
 */

export const CLIENT_INFO = { name: "kobe-mcp-proxy", version: "1.0.0" } as const;
/** Upstream protocol versions the proxy speaks (newest first). */
export const UPSTREAM_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

export type UpstreamFailure =
  | "url_not_allowed"
  | "forbidden_address"
  | "unreachable"
  | "timeout"
  | "auth_required"
  | "http_error"
  | "protocol_error"
  | "too_large";

export type UpstreamResult =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly failure: "rpc_error";
      readonly code: number;
      readonly message: string;
    }
  | { readonly ok: false; readonly failure: UpstreamFailure };

export interface UpstreamCall {
  readonly url: string;
  /** Credential headers (KOBE-61); never logged. */
  readonly headers: Readonly<Record<string, string>>;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly signal: AbortSignal;
}

export interface UpstreamClient {
  callTool(call: UpstreamCall): Promise<UpstreamResult>;
  close(): Promise<void>;
}

export interface UpstreamOptions {
  readonly policy: UpstreamPolicy;
  readonly maxResponseBytes: number;
  /** DNS resolution (tests resolve names to loopback). */
  readonly resolve?: (host: string) => Promise<LookupAddress[]>;
}

class UpstreamError extends Error {
  constructor(readonly failure: UpstreamFailure) {
    super(failure);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function defaultResolve(host: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    );
  });
}

/** Checks scheme, port and literal addresses; names are checked at connect time. */
export function checkUpstreamUrl(
  raw: string,
  policy: UpstreamPolicy,
  addresses: AddressPolicy,
): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const httpsOnly = url.protocol === "https:";
  if (!httpsOnly && !(url.protocol === "http:" && policy.allowInsecureHttp)) return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  const port = url.port === "" ? (httpsOnly ? 443 : 80) : Number(url.port);
  if (!policy.allowedPorts.includes(port)) return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && addresses.check(host) !== "allowed") return undefined;
  return url;
}

/** One SSE event's data lines joined, per the EventSource rules (enough for JSON-RPC payloads). */
function* sseEvents(buffer: { text: string }): Generator<string> {
  for (;;) {
    const match = /\r?\n\r?\n/.exec(buffer.text);
    if (!match) return;
    const block = buffer.text.slice(0, match.index);
    buffer.text = buffer.text.slice(match.index + match[0].length);
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data !== "") yield data;
  }
}

/** The JSON-RPC response to `id` in a parsed message, if it is one. */
function responseFor(message: unknown, id: number): Record<string, unknown> | undefined {
  if (!isObject(message) || message.id !== id) return undefined;
  return "result" in message || "error" in message ? message : undefined;
}

export function createUpstreamClient(options: UpstreamOptions): UpstreamClient {
  const addresses = new AddressPolicy({
    allowedInternal: options.policy.allowedInternalCidrs,
    extraDenied: options.policy.deniedCidrs,
  });
  const resolve = options.resolve ?? defaultResolve;

  // Every name is resolved once and all of its addresses must pass; connect uses a checked one.
  const dispatcher: Dispatcher = new Agent({
    connect: {
      lookup(hostname, lookupOptions, callback) {
        resolve(hostname).then(
          (found) => {
            const usable = found.filter((a) => isIP(a.address) !== 0);
            if (addresses.checkAll(usable.map((a) => a.address)) !== "allowed") {
              callback(new UpstreamError("forbidden_address"), "", 0);
              return;
            }
            const ordered = [...usable].sort((a, b) => a.family - b.family);
            if ((lookupOptions as { all?: boolean }).all) {
              (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, ordered);
            } else {
              const first = ordered[0] as LookupAddress;
              callback(null, first.address, first.family);
            }
          },
          (err: unknown) => callback(err as NodeJS.ErrnoException, "", 0),
        );
      },
    },
    connectTimeout: 10_000,
  });

  async function readLimited(body: ReadableStream<Uint8Array> | null): Promise<string> {
    if (!body) return "";
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > options.maxResponseBytes) {
        await reader.cancel();
        throw new UpstreamError("too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
  }

  /** Reads an SSE stream until the response to `id`, within the size cap. */
  async function readSse(
    body: ReadableStream<Uint8Array> | null,
    id: number,
  ): Promise<Record<string, unknown>> {
    if (!body) throw new UpstreamError("protocol_error");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const buffer = { text: "" };
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new UpstreamError("protocol_error");
        size += value.byteLength;
        if (size > options.maxResponseBytes) throw new UpstreamError("too_large");
        buffer.text += decoder.decode(value, { stream: true });
        for (const data of sseEvents(buffer)) {
          let message: unknown;
          try {
            message = JSON.parse(data);
          } catch {
            continue;
          }
          const response = responseFor(message, id);
          if (response) return response;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  interface Session {
    id?: string;
    version?: string;
  }

  async function post(
    url: URL,
    call: UpstreamCall,
    session: Session,
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const res = await undiciFetch(url, {
      method: "POST",
      dispatcher,
      redirect: "error",
      signal: call.signal,
      headers: {
        ...call.headers,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(session.id === undefined ? {} : { "mcp-session-id": session.id }),
        ...(session.version === undefined ? {} : { "mcp-protocol-version": session.version }),
      },
      body: JSON.stringify(message),
    });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new UpstreamError("auth_required");
    }
    if (!("id" in message)) {
      await res.body?.cancel();
      if (res.status >= 200 && res.status < 300) return undefined;
      throw new UpstreamError("http_error");
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new UpstreamError("http_error");
    }
    const sessionId = res.headers.get("mcp-session-id");
    if (sessionId !== null && session.id === undefined) {
      if (!/^[\x21-\x7e]{1,256}$/.test(sessionId)) throw new UpstreamError("protocol_error");
      session.id = sessionId;
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    const id = message.id as number;
    if (type === "text/event-stream") return readSse(res.body, id);
    if (type !== "application/json") {
      await res.body?.cancel();
      throw new UpstreamError("protocol_error");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readLimited(res.body));
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      throw new UpstreamError("protocol_error");
    }
    const response = responseFor(parsed, id);
    if (!response) throw new UpstreamError("protocol_error");
    return response;
  }

  function endSession(url: URL, call: UpstreamCall, session: Session): void {
    if (session.id === undefined) return;
    void undiciFetch(url, {
      method: "DELETE",
      dispatcher,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: {
        ...call.headers,
        "mcp-session-id": session.id,
        ...(session.version === undefined ? {} : { "mcp-protocol-version": session.version }),
      },
    })
      .then((res) => res.body?.cancel())
      .catch(() => undefined);
  }

  async function callTool(call: UpstreamCall): Promise<UpstreamResult> {
    const url = checkUpstreamUrl(call.url, options.policy, addresses);
    if (!url) return { ok: false, failure: "url_not_allowed" };
    const session: Session = {};
    try {
      const init = await post(url, call, session, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: UPSTREAM_PROTOCOL_VERSIONS[0],
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      });
      const initResult = init?.result;
      const version = isObject(initResult) ? initResult.protocolVersion : undefined;
      if (
        typeof version !== "string" ||
        !(UPSTREAM_PROTOCOL_VERSIONS as readonly string[]).includes(version)
      ) {
        return { ok: false, failure: "protocol_error" };
      }
      session.version = version;
      await post(url, call, session, { jsonrpc: "2.0", method: "notifications/initialized" });
      const response = await post(url, call, session, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: call.tool, arguments: call.arguments },
      });
      if (response && isObject(response.error)) {
        const { code, message } = response.error;
        return {
          ok: false,
          failure: "rpc_error",
          code: typeof code === "number" && Number.isSafeInteger(code) ? code : -32603,
          message: typeof message === "string" ? message.slice(0, 1000) : "Upstream error.",
        };
      }
      if (!response || !isObject(response.result)) return { ok: false, failure: "protocol_error" };
      return { ok: true, result: response.result };
    } catch (err) {
      if (err instanceof UpstreamError) return { ok: false, failure: err.failure };
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof UpstreamError) return { ok: false, failure: cause.failure };
      if (call.signal.aborted) return { ok: false, failure: "timeout" };
      return { ok: false, failure: "unreachable" };
    } finally {
      endSession(url, call, session);
    }
  }

  return {
    callTool,
    close: () => dispatcher.close(),
  };
}
