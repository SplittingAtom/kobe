import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from "node:tls";
import { normalizeHost, type InjectedHeader } from "@kobe/db";
import type { EgressDecision } from "./allowlist.js";
import { authenticate, type SandboxIdentity } from "./auth.js";
import type { ConnectionReason, ConnectionRecord } from "./connection-audit.js";
import type { ProxyDeps } from "./proxy.js";

/**
 * Header injection by upgrade (spec D28, KOBE-39; user decision 2026-10-03). For a domain whose team
 * configured injected headers (e.g. a private package index's token), the sandbox sends a plain
 * HTTP proxy request (`GET http://pkgs.example.com/simple/ HTTP/1.1` with its egress token in
 * `Proxy-Authorization`). The proxy
 *
 * 1. authenticates the token and checks active membership and the allowlist, exactly as for
 *    CONNECT (a refusal is the same `egress.blocked` with request access);
 * 2. requires header rules for the matched pattern (plain HTTP to anything else stays refused);
 * 3. resolves the host once, refuses internal addresses (rebinding gains nothing), connects to the
 *    checked address on 443 and does TLS **itself**, with SNI = the host and the certificate
 *    verified against it (system CAs): there is no TLS interception and no Kobe CA;
 * 4. strips hop-by-hop headers, `Proxy-*` and any client header named like an injected one, sets
 *    `Host`, adds the team's headers (opened here, never sent to the sandbox), and relays the
 *    response with size, time and bandwidth limits;
 * 5. rewrites a redirect to the same host's `https://` URL into `http://` (so the next request
 *    comes back here and is re-checked and re-injected); a redirect to another host is passed on
 *    untouched: the client's next request goes through the proxy again and is checked for that
 *    host like any other (the injected headers are never sent anywhere but their own host).
 *
 * Responses never carry the injected values back in headers: a response header containing one is
 * dropped. A response body is the upstream's own (see docs/install.md for that trust boundary).
 */
export interface UpgradeSettings {
  /** Request body limit (uploads, e.g. `twine upload`). */
  readonly maxRequestBytes: number;
  /** Response body limit (downloads). */
  readonly maxResponseBytes: number;
  /** Whole exchange, from the request head to the last response byte. */
  readonly timeoutMs: number;
}

export interface HeaderOpener {
  /** The team's headers for the pattern (throws when the sealed value does not open). */
  open(teamId: string, pattern: string, sealed: string): InjectedHeader[];
}

export interface UpgradeAttempt {
  readonly identity: SandboxIdentity;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly started: number;
}

export interface UpgradeContext {
  readonly deps: ProxyDeps;
  /** Counts the request in the connection audit and logs it (proxy.ts `finish`). */
  finish(
    a: UpgradeAttempt,
    outcome: ConnectionRecord["outcome"],
    reason: ConnectionReason | undefined,
    bytes?: { bytesUp: number; bytesDown: number },
    upgraded?: boolean,
  ): void;
  /** Records an `egress.blocked` event (blocked-reporter). */
  report(a: UpgradeAttempt, reason: ConnectionReason, requestAccess: boolean): void;
  /** Rate-limited log of a refused authentication. */
  authRefused(source: string, reason: string): void;
}

const UPSTREAM_PORT = 443;
/** Methods relayed; TRACE (reflects the injected headers), CONNECT and the rest are refused. */
export const UPGRADE_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
/** Header names compared the way CGI-style servers see them (`X_Api_Key` = `X-Api-Key`). */
const headerKey = (name: string) => name.toLowerCase().replace(/_/g, "-");
const REALM = 'Basic realm="kobe-egress"';

/** Never forwarded upstream (hop-by-hop, proxy credentials, framing the proxy decides). */
const DROP_REQUEST = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "expect",
  "http2-settings",
  "content-length",
]);
/** Never relayed back to the sandbox. */
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "alt-svc",
  "content-length",
]);

/** Status line + plain-text body; `reason` is built from checked values only. */
function reply(
  res: ServerResponse,
  status: number,
  reason: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = `${body}\n`;
  res.writeHead(status, reason, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(text)),
    connection: "close",
    ...headers,
  });
  res.end(text);
}

/** Header names the client listed in `Connection` (hop-by-hop by declaration). */
function connectionTokens(value: string | string[] | undefined): Set<string> {
  const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
  return new Set(
    joined
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== ""),
  );
}

/** The request headers sent upstream: the client's minus what is dropped, plus the injected ones. */
export function upstreamHeaders(
  rawHeaders: readonly string[],
  host: string,
  injected: readonly InjectedHeader[],
  contentLength: number | undefined,
): [string, string][] {
  const out: [string, string][] = [];
  const injectedNames = new Set(injected.map((h) => headerKey(h.name)));
  const listed = new Map<string, string[]>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const lower = name.toLowerCase();
    if (lower === "connection") {
      for (const token of connectionTokens(rawHeaders[i + 1])) listed.set(headerKey(token), []);
    }
  }
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    // Compared as CGI-style servers see names: `Content_Length` is `Content-Length`.
    const key = headerKey(name);
    if (DROP_REQUEST.has(key) || listed.has(key) || injectedNames.has(key)) continue;
    if (key.startsWith("proxy-")) continue;
    out.push([name, rawHeaders[i + 1] as string]);
  }
  out.unshift(["Host", host]);
  if (contentLength !== undefined) out.push(["Content-Length", String(contentLength)]);
  for (const h of injected) out.push([h.name, h.value]);
  return out;
}

/**
 * A `Location` for the client: the same host's https URL becomes http (so it comes back through
 * the upgrade and is re-checked); anything else is passed unchanged (re-checked as its own request).
 */
export function rewriteLocation(location: string, host: string): string {
  let url: URL;
  try {
    url = new URL(location, `https://${host}/`);
  } catch {
    return location;
  }
  if (
    url.protocol === "https:" &&
    url.hostname === host &&
    (url.port === "" || url.port === "443")
  ) {
    return `http://${host}${url.pathname}${url.search}${url.hash}`;
  }
  return location;
}

/**
 * The secret parts of an injected value: the whole value and, for `<scheme> <credential>` values
 * (`Bearer x`, `Basic x`), the credential alone. Parts shorter than 4 characters are not matched.
 */
export function secretParts(injected: readonly InjectedHeader[]): string[] {
  const parts = new Set<string>();
  for (const h of injected) {
    parts.add(h.value);
    const space = h.value.indexOf(" ");
    if (space > 0) parts.add(h.value.slice(space + 1).trim());
  }
  return [...parts].filter((p) => p.length >= 4);
}

function containsSecret(value: string, injected: readonly InjectedHeader[]): boolean {
  return secretParts(injected).some((p) => value.includes(p));
}

/** The response headers relayed to the sandbox (multi-valued ones kept as such). */
export function downstreamHeaders(
  rawHeaders: readonly string[],
  host: string,
  injected: readonly InjectedHeader[],
): [string, string][] {
  const listed = new Set<string>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if ((rawHeaders[i] as string).toLowerCase() === "connection") {
      for (const t of connectionTokens(rawHeaders[i + 1])) listed.add(t);
    }
  }
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const lower = name.toLowerCase();
    let value = rawHeaders[i + 1] as string;
    if (DROP_RESPONSE.has(lower) || listed.has(lower)) continue;
    // An upstream echoing a credential back in a header never shows it to the sandbox.
    if (containsSecret(value, injected)) continue;
    if (lower === "location" || lower === "content-location") value = rewriteLocation(value, host);
    out.push([name, value]);
  }
  return out;
}

interface Target {
  readonly host: string;
  readonly path: string;
}

type TargetResult =
  | { readonly ok: true; readonly target: Target }
  | { readonly ok: false; readonly host: string | undefined; readonly why: string };

/** `http://host[:80]/path?query` (absolute-form), host a name: anything else is refused. */
export function parsePlainTarget(raw: string | undefined): TargetResult {
  if (!raw || raw.length > 8192 || !/^http:\/\//i.test(raw)) {
    return { ok: false, host: undefined, why: "only http:// absolute URLs" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, host: undefined, why: "not a URL" };
  }
  const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const host = isIP(literal) === 0 ? normalizeHost(url.hostname) : null;
  if (url.username !== "" || url.password !== "") {
    return { ok: false, host: host ?? undefined, why: "credentials in the URL" };
  }
  if (host === null) return { ok: false, host: undefined, why: "a host name is required" };
  if (url.port !== "" && url.port !== "80") {
    return { ok: false, host, why: "plain HTTP uses the default port" };
  }
  return { ok: true, target: { host, path: `${url.pathname}${url.search}` } };
}

async function verifiedTls(
  tcp: Socket,
  host: string,
  timeoutMs: number,
  ca: string | Buffer | readonly (string | Buffer)[] | undefined,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({
      socket: tcp,
      servername: host,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.2",
      ...(ca === undefined ? {} : { ca: ca as string | Buffer | (string | Buffer)[] }),
      // The certificate must name the host the sandbox asked for (never the address).
      checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert),
    });
    const timer = setTimeout(() => {
      tls.destroy();
      reject(new Error("TLS handshake timeout"));
    }, timeoutMs);
    tls.once("secureConnect", () => {
      clearTimeout(timer);
      tls.removeAllListeners("error");
      tls.on("error", () => tls.destroy());
      resolve(tls);
    });
    tls.once("error", (err) => {
      clearTimeout(timer);
      tcp.destroy();
      reject(err);
    });
  });
}

/** Handles one absolute-form (plain HTTP) proxy request. */
export async function handlePlainHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: UpgradeContext,
): Promise<void> {
  const { deps } = ctx;
  const started = Date.now();
  const auth = authenticate(req.headers["proxy-authorization"], deps.verify);
  if (!auth.ok) {
    ctx.authRefused(req.socket.remoteAddress ?? "unknown", auth.reason);
    reply(
      res,
      407,
      "Proxy Authentication Required",
      "Kobe egress proxy: send the sandbox's egress session token.",
      { "proxy-authenticate": REALM },
    );
    return;
  }
  const identity = auth.identity;
  deps.preauth?.authenticated(req.socket);
  const parsed = parsePlainTarget(req.url);
  const attempt: UpgradeAttempt = {
    identity,
    host: parsed.ok ? parsed.target.host : parsed.host,
    port: 80,
    started,
  };
  const release = deps.connections.tryAcquire(identity.sandboxId);
  if (!release) {
    ctx.finish(attempt, "blocked", "connection_limit");
    reply(
      res,
      429,
      "Kobe egress: too many connections",
      "Kobe egress: this sandbox has too many open connections; close some and retry.",
    );
    return;
  }
  try {
    if (!parsed.ok) {
      ctx.finish(attempt, "blocked", "invalid_target");
      reply(
        res,
        403,
        "Kobe egress blocked: invalid target",
        `Kobe egress: plain HTTP needs an http://<host name>/ URL (${parsed.why}).`,
      );
      return;
    }
    if (!UPGRADE_METHODS.has(req.method ?? "")) {
      ctx.finish(attempt, "blocked", "invalid_target");
      reply(
        res,
        405,
        "Kobe egress: method not allowed",
        "Kobe egress: only GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS are relayed.",
      );
      return;
    }
    await upgrade(req, res, ctx, attempt, parsed.target);
  } finally {
    release();
  }
}

async function decideFor(
  ctx: UpgradeContext,
  res: ServerResponse,
  attempt: UpgradeAttempt,
  host: string,
): Promise<{ pattern: string; sealed: string | undefined } | undefined> {
  const { deps } = ctx;
  const { identity } = attempt;
  let decision: EgressDecision;
  let sealed: string | undefined;
  try {
    if (!(await deps.policy.isActiveMember(identity.teamId, identity.userId))) {
      ctx.finish(attempt, "blocked", "inactive_member");
      reply(
        res,
        403,
        "Kobe egress blocked: not an active team member",
        "Kobe egress: this sandbox's user is not an active member of its team.",
      );
      return undefined;
    }
    decision = await deps.policy.decide(identity.teamId, host);
    sealed =
      decision.allowed && deps.policy.sealedHeaders
        ? await deps.policy.sealedHeaders(identity.teamId, decision.pattern)
        : undefined;
  } catch (err) {
    deps.logger.error({ err, team: identity.teamId }, "egress allowlist unavailable");
    ctx.finish(attempt, "failed", "policy_unavailable");
    reply(
      res,
      503,
      "Kobe egress: allowlist unavailable",
      "Kobe egress: the allowlist could not be read; try again shortly.",
    );
    return undefined;
  }
  if (!decision.allowed) {
    const enabled = decision.reason === "not_enabled";
    ctx.finish(attempt, "blocked", decision.reason);
    ctx.report(attempt, decision.reason, enabled);
    if (enabled) {
      reply(
        res,
        403,
        `Kobe egress blocked: ${host} is not enabled for this team`,
        `Kobe egress: ${host} is not enabled for this team. A team admin can enable it (Request access).`,
      );
    } else {
      reply(
        res,
        403,
        `Kobe egress blocked: ${host} is not allowed in this install`,
        `Kobe egress: ${host} is not in this install's egress ceiling; an install admin must add it first.`,
      );
    }
    return undefined;
  }
  return { pattern: decision.pattern, sealed };
}

async function upgrade(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: UpgradeContext,
  attempt: UpgradeAttempt,
  target: Target,
): Promise<void> {
  const { deps } = ctx;
  const { identity } = attempt;
  const { host } = target;
  const decided = await decideFor(ctx, res, attempt, host);
  if (!decided) return;
  // Headers are bound to exactly one host: a wildcard pattern would let the sandbox send them to
  // any subdomain it controls (the API refuses them too; this also disarms any older row).
  const exact = decided.pattern === host;
  if (decided.sealed === undefined || !exact || !deps.headers || !deps.upgrade) {
    // Plain HTTP exists only to carry a team's injected headers; everything else is HTTPS.
    ctx.finish(attempt, "blocked", "plain_http");
    reply(
      res,
      403,
      "Kobe egress blocked: plain HTTP is not allowed",
      "Kobe egress: only HTTPS (CONNECT) is allowed; use an https:// URL.",
    );
    return;
  }
  let injected: InjectedHeader[];
  try {
    injected = deps.headers.open(identity.teamId, decided.pattern, decided.sealed);
  } catch (err) {
    deps.logger.error(
      { err: (err as Error).message, team: identity.teamId, host },
      "egress injected headers do not open (wrong or rotated secret?)",
    );
    ctx.finish(attempt, "failed", "policy_unavailable");
    reply(
      res,
      503,
      "Kobe egress: header injection unavailable",
      "Kobe egress: the team's headers for this domain could not be read; ask a team admin to set them again.",
    );
    return;
  }
  const limits = deps.upgrade;
  const declared = req.headers["content-length"];
  const length = declared === undefined ? undefined : Number(declared);
  if (length !== undefined && (!Number.isSafeInteger(length) || length > limits.maxRequestBytes)) {
    ctx.finish(attempt, "blocked", "request_too_large");
    reply(
      res,
      413,
      "Kobe egress: request too large",
      `Kobe egress: request bodies are limited to ${limits.maxRequestBytes} bytes.`,
    );
    return;
  }

  const detach = deps.bandwidth.attach(identity.sandboxId);
  try {
    let addresses: string[];
    try {
      addresses = await deps.resolve(host);
    } catch {
      ctx.finish(attempt, "failed", "dns_failure");
      reply(
        res,
        502,
        `Kobe egress: cannot resolve ${host}`,
        `Kobe egress: ${host} does not resolve.`,
      );
      return;
    }
    if (deps.addresses.checkAll(addresses) !== "allowed") {
      ctx.finish(attempt, "blocked", "forbidden_address");
      ctx.report(attempt, "forbidden_address", false);
      reply(
        res,
        403,
        `Kobe egress blocked: ${host} resolves to an internal address`,
        `Kobe egress: ${host} resolves to an internal or reserved address, which sandboxes may never reach.`,
      );
      return;
    }
    await exchange(req, res, ctx, attempt, target, addresses, injected, length);
  } finally {
    detach();
  }
}

async function exchange(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: UpgradeContext,
  attempt: UpgradeAttempt,
  target: Target,
  addresses: readonly string[],
  injected: readonly InjectedHeader[],
  length: number | undefined,
): Promise<void> {
  const { deps } = ctx;
  const limits = deps.upgrade as UpgradeSettings;
  const { host } = target;
  const { identity } = attempt;
  const deadline = attempt.started + limits.timeoutMs;
  const connect = deps.connectUpstream;
  if (!connect) throw new Error("connectUpstream missing");
  // IPv4 first, at most 3 checked addresses: the same rule as tunnels.
  const ordered = [...addresses].sort((a, b) => isIP(a) - isIP(b)).slice(0, 3);
  let tcp: Socket | undefined;
  for (const address of ordered) {
    try {
      tcp = await connect(address, UPSTREAM_PORT, deps.settings.connectTimeoutMs);
      break;
    } catch {
      // next address
    }
  }
  if (!tcp) {
    ctx.finish(attempt, "failed", "upstream_unreachable");
    reply(
      res,
      502,
      `Kobe egress: cannot connect to ${host}`,
      `Kobe egress: ${host} did not accept a connection.`,
    );
    return;
  }
  let tls: TLSSocket;
  try {
    tls = await verifiedTls(tcp, host, deps.settings.handshakeTimeoutMs, deps.upstreamCa);
  } catch (err) {
    deps.logger.info(
      { team: identity.teamId, host, why: (err as Error).message },
      "egress upgrade: TLS refused",
    );
    ctx.finish(attempt, "failed", "upstream_tls");
    reply(
      res,
      502,
      `Kobe egress: ${host} TLS could not be verified`,
      `Kobe egress: ${host}'s HTTPS certificate could not be verified for that name.`,
    );
    return;
  }

  let bytesUp = 0;
  let bytesDown = 0;
  let failure: ConnectionReason | undefined;
  const timers = new Set<NodeJS.Timeout>();
  const throttle = (src: { pause(): void; resume(): void }, n: number) => {
    const delay = deps.bandwidth.take(identity.sandboxId, n);
    if (delay <= 0) return;
    src.pause();
    const t = setTimeout(() => {
      timers.delete(t);
      src.resume();
    }, delay);
    timers.add(t);
  };
  const outgoing = httpRequest({
    createConnection: () => tls,
    method: req.method,
    path: target.path,
    headers: upstreamHeaders(req.rawHeaders, host, injected, length).flat() as unknown as Record<
      string,
      string
    >,
    setHost: false,
  });
  /** Ends the exchange: an error status while nothing was relayed yet, a cut connection after. */
  const fail = (reason: ConnectionReason) => {
    if (failure !== undefined) return;
    failure = reason;
    outgoing.destroy();
    tls.destroy();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = reason === "upstream_timeout" ? 504 : reason === "request_too_large" ? 413 : 502;
    reply(
      res,
      status,
      `Kobe egress: ${host} request failed`,
      `Kobe egress: the request to ${host} failed (${reason}).`,
    );
  };
  const overall = setTimeout(() => fail("upstream_timeout"), Math.max(0, deadline - Date.now()));
  const unregister = deps.tunnels?.register(
    {
      teamId: identity.teamId,
      userId: identity.userId,
      host,
      close: () => {
        fail("not_enabled");
        res.destroy();
      },
    },
    Math.min(identity.expiresAt, deadline),
  );
  tls.setTimeout(deps.settings.idleTimeoutMs, () => fail("upstream_timeout"));

  const done = new Promise<void>((resolve) => {
    const finishOnce = (() => {
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        resolve();
      };
    })();
    res.once("close", finishOnce);
    outgoing.once("error", () => {
      fail("upstream_unreachable");
      finishOnce();
    });
    outgoing.once("response", (upstreamRes: IncomingMessage) => {
      const declared = Number(upstreamRes.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
        failure = "response_too_large";
        reply(
          res,
          502,
          "Kobe egress: response too large",
          `Kobe egress: responses are limited to ${limits.maxResponseBytes} bytes.`,
        );
        upstreamRes.destroy();
        tls.destroy();
        return;
      }
      const headers = downstreamHeaders(upstreamRes.rawHeaders, host, injected);
      if (upstreamRes.headers["content-length"] !== undefined) {
        headers.push(["Content-Length", String(upstreamRes.headers["content-length"])]);
      }
      // One request per connection: an authenticated socket has left the pre-auth budget and
      // holds a connection slot only while its request runs, so it must not idle afterwards.
      headers.push(["Connection", "close"]);
      // The upstream's reason phrase is not relayed (Node's standard one is used).
      res.writeHead(upstreamRes.statusCode ?? 502, headers.flat());
      upstreamRes.on("data", (chunk: Buffer) => {
        bytesDown += chunk.length;
        if (bytesDown > limits.maxResponseBytes) {
          upstreamRes.destroy();
          fail("response_too_large");
          return;
        }
        if (!res.write(chunk)) {
          upstreamRes.pause();
          res.once("drain", () => upstreamRes.resume());
        }
        throttle(upstreamRes, chunk.length);
      });
      upstreamRes.once("end", () => res.end());
      upstreamRes.once("error", () => fail("upstream_unreachable"));
    });
  });

  req.on("data", (chunk: Buffer) => {
    bytesUp += chunk.length;
    if (bytesUp > limits.maxRequestBytes) {
      fail("request_too_large");
      return;
    }
    if (!outgoing.write(chunk)) {
      req.pause();
      outgoing.once("drain", () => req.resume());
    }
    throttle(req, chunk.length);
  });
  req.once("end", () => outgoing.end());
  req.once("error", () => fail("upstream_unreachable"));

  try {
    await done;
  } finally {
    clearTimeout(overall);
    for (const t of timers) clearTimeout(t);
    unregister?.();
    tls.destroy();
  }
  if (failure !== undefined) {
    ctx.finish(attempt, "failed", failure, { bytesUp, bytesDown }, true);
  } else {
    ctx.finish(attempt, "allowed", undefined, { bytesUp, bytesDown }, true);
  }
}
