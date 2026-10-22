import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";

/**
 * The git mirror's HTTP client for isomorphic-git (KOBE-343). It only ever talks to the mirror's
 * own origin: any other URL is refused, redirects are never followed (a 3xx reaches git as an
 * error), and the Basic credentials go only to that origin. In a cluster every request goes
 * through the egress proxy (spec SK29: pushes run server-side through it): CONNECT host:port with
 * a fresh site egress token, then TLS to the remote, verified against the system CAs.
 */
export interface MirrorHttpOptions {
  /** The mirror remote; only its origin is reachable. */
  readonly remote: string;
  readonly credentials: { readonly username: string; readonly token: string } | null;
  /** The egress proxy and a token per connection; null connects directly (tests only). */
  readonly proxy: { readonly url: string; readonly token: () => string } | null;
  /** Extra CAs (tests); production trusts the system store (and NODE_EXTRA_CA_CERTS). */
  readonly ca?: string | readonly string[];
  /** Plain-HTTP remotes are for tests only. */
  readonly allowInsecureHttp?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export const MIRROR_HTTP_TIMEOUT_MS = 60_000;
export const MIRROR_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024 * 1024;

/** A transport failure the mirror reports; never carries the token or a request body. */
export class MirrorHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorHttpError";
  }
}

async function collect(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    size += c.length;
    if (size > MAX_REQUEST_BYTES) throw new MirrorHttpError("the push is too large");
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

function flatHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

async function* capped(res: IncomingMessage, max: number): AsyncIterableIterator<Uint8Array> {
  let size = 0;
  for await (const chunk of res) {
    const c = chunk as Buffer;
    size += c.length;
    if (size > max) {
      res.destroy();
      throw new MirrorHttpError("the remote's answer is too large");
    }
    yield new Uint8Array(c.buffer, c.byteOffset, c.length);
  }
}

/** Opens CONNECT host:port at the proxy; resolves with the raw tunnel socket. */
function connectThrough(
  proxy: { url: string; token: () => string },
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: p.hostname,
      port: p.port || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, "proxy-authorization": `Bearer ${proxy.token()}` },
      agent: false,
      timeout: timeoutMs,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode === 200) {
        resolve(socket);
        return;
      }
      socket.destroy();
      // The proxy's status line says why (e.g. "… is not allowed on this site").
      reject(
        new MirrorHttpError(
          `the egress proxy refused ${host}: ${res.statusCode ?? "?"} ${res.statusMessage ?? ""}`.trim(),
        ),
      );
    });
    req.once("timeout", () => req.destroy(new MirrorHttpError("the egress proxy timed out")));
    req.once("error", (err) =>
      reject(
        err instanceof MirrorHttpError
          ? err
          : new MirrorHttpError(`the egress proxy is unreachable (${(err as Error).message})`),
      ),
    );
    req.end();
  });
}

function tlsOver(socket: Socket, host: string, ca: MirrorHttpOptions["ca"]): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({
      socket,
      servername: host,
      ...(ca ? { ca: typeof ca === "string" ? ca : [...ca] } : {}),
    });
    tls.once("secureConnect", () => resolve(tls));
    tls.once("error", (err) => {
      socket.destroy();
      reject(new MirrorHttpError(`TLS to ${host} failed (${err.message})`));
    });
  });
}

export function mirrorHttpClient(options: MirrorHttpOptions): HttpClient {
  const remote = new URL(options.remote);
  const timeoutMs = options.timeoutMs ?? MIRROR_HTTP_TIMEOUT_MS;
  const maxResponse = options.maxResponseBytes ?? MIRROR_MAX_RESPONSE_BYTES;
  if (remote.protocol !== "https:" && !(options.allowInsecureHttp && remote.protocol === "http:"))
    throw new MirrorHttpError("the mirror needs an https remote");
  const authorization = options.credentials
    ? `Basic ${Buffer.from(`${options.credentials.username}:${options.credentials.token}`).toString("base64")}`
    : undefined;

  async function send(req: GitHttpRequest): Promise<GitHttpResponse> {
    const url = new URL(req.url);
    if (url.origin !== remote.origin)
      throw new MirrorHttpError("the mirror only talks to its own remote");
    const body = await collect(req.body);
    const https = url.protocol === "https:";
    const port = Number(url.port || (https ? 443 : 80));
    // Only Kobe's own credentials: whatever git put in an Authorization header is dropped.
    const headers: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(req.headers ?? {}).filter(([k]) => k.toLowerCase() !== "authorization"),
      ),
      ...(authorization ? { authorization } : {}),
      ...(body.length > 0 ? { "content-length": String(body.length) } : {}),
    };
    const base: RequestOptions = {
      host: url.hostname,
      port,
      method: req.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
      timeout: timeoutMs,
    };
    let send: () => ReturnType<typeof httpRequest>;
    if (options.proxy && https) {
      const tls = await tlsOver(
        await connectThrough(options.proxy, url.hostname, port, timeoutMs),
        url.hostname,
        options.ca,
      );
      // No agent: Node uses createConnection only without one (agent: false would dial TCP).
      const { agent: _agent, ...viaTunnel } = base;
      send = () => httpRequest({ ...viaTunnel, createConnection: () => tls });
    } else if (options.proxy) {
      throw new MirrorHttpError("the egress proxy carries https only");
    } else if (https) {
      const ca = options.ca;
      send = () =>
        httpsRequest({
          ...base,
          servername: url.hostname,
          ...(ca ? { ca: typeof ca === "string" ? ca : [...ca] } : {}),
        });
    } else send = () => httpRequest(base);

    return new Promise((resolve, reject) => {
      const r = send();
      r.once("timeout", () => r.destroy(new MirrorHttpError(`${url.hostname} timed out`)));
      r.once("error", (err) =>
        reject(
          err instanceof MirrorHttpError
            ? err
            : new MirrorHttpError(`${url.hostname} is unreachable (${err.message})`),
        ),
      );
      r.once("response", (res) => {
        resolve({
          url: req.url,
          method: base.method ?? "GET",
          statusCode: res.statusCode ?? 0,
          statusMessage: res.statusMessage ?? "",
          headers: flatHeaders(res),
          body: capped(res, maxResponse),
        });
      });
      r.end(body);
    });
  }

  return { request: send };
}
