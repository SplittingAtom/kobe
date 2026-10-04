import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { normalizeHost } from "@kobe/db";
import type { Logger } from "pino";
import type { AddressPolicy } from "./address-policy.js";
import type { EgressDecision } from "./allowlist.js";
import { authenticate, type SandboxIdentity, type TokenVerifier } from "./auth.js";
import type { BlockedAttempt } from "./blocked-reporter.js";
import { MAX_CLIENT_HELLO_BYTES, parseClientHello } from "./client-hello.js";
import type { ConnectionReason, ConnectionRecord } from "./connection-audit.js";
import type { BandwidthLimiter, ConnectionLimits } from "./limits.js";
import type { ResolveHost } from "./resolver.js";
import type { PreAuthGate } from "./preauth-gate.js";
import { RateBuckets } from "./rate-buckets.js";
import type { TunnelRegistry } from "./tunnel-registry.js";
import { runTunnel } from "./tunnel.js";
import {
  handlePlainHttp,
  type HeaderOpener,
  type UpgradeContext,
  type UpgradeSettings,
} from "./upgrade.js";

/**
 * The egress proxy (spec D28): default deny, HTTPS only, per-team allowlists within the install
 * ceiling. A sandbox sends `CONNECT host:443` with its egress session token; the proxy
 *
 * 1. authenticates the token (team, user, sandbox come from it) and checks the user is still an
 *    active member of the team;
 * 2. allows only ports in `allowedPorts` (443) and host names (no IP literals);
 * 3. checks the host against the team's effective allowlist (enablement ∩ ceiling);
 * 4. resolves the host itself and refuses it if any address is internal (private, loopback,
 *    link-local/metadata, cluster ranges) unless explicitly allowed; connects to an address it
 *    checked (no second lookup, so DNS rebinding gains nothing);
 * 5. replies 200, reads the TLS ClientHello and requires its SNI to equal the CONNECT host (no SNI,
 *    another name or another protocol tears the tunnel down);
 * 6. relays bytes without decrypting them, under per-sandbox connection, bandwidth and idle limits.
 *
 * Plain-HTTP proxy requests are refused, except for domains whose team configured injected headers
 * (KOBE-39): those are upgraded to verified HTTPS by the proxy itself (upgrade.ts), and a CONNECT
 * to such a domain is refused with a pointer to `http://` (a tunnel could not carry the headers).
 * Every authenticated attempt is counted in the
 * aggregated `egress.connection` audit; refusals of a named host also record an `egress.blocked`
 * event for the run (blocked-reporter.ts).
 */
export interface ProxySettings {
  readonly allowedPorts: readonly number[];
  readonly idleTimeoutMs: number;
  /** TLS ClientHello deadline after the 200. */
  readonly handshakeTimeoutMs: number;
  /** Request-head deadline for new sockets (pre-authentication; slow-loris bound). */
  readonly preAuthTimeoutMs: number;
  readonly connectTimeoutMs: number;
  /** Longest a tunnel may live (it also closes when the token that opened it expires). */
  readonly maxTunnelMs: number;
}

export interface ProxyPolicy {
  decide(teamId: string, host: string): Promise<EgressDecision>;
  isActiveMember(teamId: string, userId: string): Promise<boolean>;
  /** The team's sealed injected headers for an enabled pattern (KOBE-39), if any. */
  sealedHeaders?(teamId: string, pattern: string): Promise<string | undefined>;
}

export type ConnectUpstream = (address: string, port: number, timeoutMs: number) => Promise<Socket>;

export interface ProxyDeps {
  readonly verify: TokenVerifier;
  readonly policy: ProxyPolicy;
  readonly resolve: ResolveHost;
  readonly addresses: AddressPolicy;
  readonly connections: ConnectionLimits;
  readonly bandwidth: BandwidthLimiter;
  readonly audit: { record(record: ConnectionRecord): void };
  readonly blocked: { report(attempt: BlockedAttempt): void };
  readonly logger: Logger;
  readonly settings: ProxySettings;
  readonly connectUpstream?: ConnectUpstream;
  /** Caps sockets that have not authenticated yet, per source and in total. */
  readonly preauth?: PreAuthGate;
  /** Open tunnels, for revocation on change hints. */
  readonly tunnels?: TunnelRegistry;
  /** Health endpoint state (readyz turns 503 while draining). */
  readonly ready?: () => boolean;
  /** Opens the teams' sealed injected headers (KOBE-39); absent: header injection off. */
  readonly headers?: HeaderOpener;
  /** Limits of upgraded plain-HTTP requests (KOBE-39); absent: header injection off. */
  readonly upgrade?: UpgradeSettings;
  /** Extra CAs trusted for upgraded requests (tests); production uses the system store only. */
  readonly upstreamCa?: string | Buffer | readonly (string | Buffer)[];
}

const SERVICE = "egress-proxy";
const REALM = 'Basic realm="kobe-egress"';

export const tcpConnect: ConnectUpstream = (address, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = netConnect({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connect timeout"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      // Until the tunnel takes over (it adds its own handler): an error just closes the socket.
      socket.on("error", () => socket.destroy());
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

/** HTTP server sockets allow half-open connections: close for real shortly after replying. */
const LINGER_MS = 1_000;

function closeSoon(socket: Socket): void {
  setTimeout(() => socket.destroy(), LINGER_MS).unref();
}

/** A raw HTTP/1.1 response on a CONNECT socket, then close. `reason` is built from checked values. */
function reply(
  socket: Socket,
  status: number,
  reason: string,
  body: string,
  headers: string[] = [],
): void {
  if (socket.destroyed) return;
  const text = `${body}\n`;
  closeSoon(socket);
  socket.end(
    [
      `HTTP/1.1 ${status} ${reason}`,
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(text)}`,
      "Connection: close",
      ...headers,
      "",
      text,
    ].join("\r\n"),
  );
}

/** `host:port` (or `[v6]:port`) of a CONNECT request. */
export function parseConnectTarget(
  url: string | undefined,
): { host: string; port: number } | undefined {
  if (!url || url.length > 300) return undefined;
  const colon = url.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const rawPort = url.slice(colon + 1);
  if (!/^[0-9]{1,5}$/.test(rawPort)) return undefined;
  const port = Number(rawPort);
  if (port < 1 || port > 65535) return undefined;
  let host = url.slice(0, colon);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host ? { host, port } : undefined;
}

interface Attempt {
  readonly identity: SandboxIdentity;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly started: number;
}

export function createEgressProxy(deps: ProxyDeps): Server {
  const { logger, settings } = deps;
  const connectUpstream = deps.connectUpstream ?? tcpConnect;
  // Failed authentications are logged at most a few times per source per minute.
  const authLogs = new RateBuckets({ burst: 5, perSecond: 0.1 });

  const finish = (
    a: Attempt,
    outcome: ConnectionRecord["outcome"],
    reason: ConnectionReason | undefined,
    bytes: { bytesUp: number; bytesDown: number } = { bytesUp: 0, bytesDown: 0 },
    upgraded = false,
  ) => {
    const { identity } = a;
    deps.audit.record({
      ...(upgraded ? { upgraded: true } : {}),
      teamId: identity.teamId,
      userId: identity.userId,
      sandboxId: identity.sandboxId,
      domain: a.host,
      port: a.port,
      outcome,
      reason,
      ...bytes,
    });
    logger.info(
      {
        team: identity.teamId,
        user: identity.userId,
        sandbox: identity.sandboxId,
        host: a.host,
        port: a.port,
        outcome,
        reason,
        bytesUp: bytes.bytesUp,
        bytesDown: bytes.bytesDown,
        ...(upgraded ? { upgraded: true } : {}),
        ms: Date.now() - a.started,
      },
      "egress connection",
    );
  };

  const block = (
    socket: Socket,
    a: Attempt,
    reason: ConnectionReason,
    status: number,
    phrase: string,
    body: string,
    requestAccess = false,
  ) => {
    finish(a, "blocked", reason);
    if (a.host !== undefined && a.port !== undefined) {
      deps.blocked.report({
        teamId: a.identity.teamId,
        userId: a.identity.userId,
        sandboxId: a.identity.sandboxId,
        domain: a.host,
        port: a.port,
        reason,
        requestAccess,
        threadHint: a.identity.threadHint,
      });
    }
    reply(socket, status, phrase, body);
  };

  async function handleConnect(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const started = Date.now();
    socket.setNoDelay(true);
    socket.on("error", () => socket.destroy());
    // Bounds the whole set-up (policy lookups, DNS, connect, ClientHello); the tunnel then sets
    // its own idle timeout on the same socket.
    socket.setTimeout(settings.handshakeTimeoutMs + settings.connectTimeoutMs * 2, () =>
      socket.destroy(),
    );
    socket.pause();

    const auth = authenticate(req.headers["proxy-authorization"], deps.verify);
    if (!auth.ok) {
      const source = socket.remoteAddress ?? "unknown";
      if (authLogs.take(source)) {
        logger.info({ reason: auth.reason, remote: source }, "egress proxy auth refused");
      }
      reply(
        socket,
        407,
        "Proxy Authentication Required",
        "Kobe egress proxy: send the sandbox's egress session token.",
        [`Proxy-Authenticate: ${REALM}`],
      );
      return;
    }
    const identity = auth.identity;
    // Authenticated sockets leave the pre-auth pool and hold one of the sandbox's tunnel slots
    // from here on (set-up included), so set-up floods are bounded per sandbox too.
    deps.preauth?.authenticated(socket);
    const target = parseConnectTarget(req.url);
    const host = target ? normalizeHost(target.host) : null;
    const attempt: Attempt = { identity, host: host ?? undefined, port: target?.port, started };
    const release = deps.connections.tryAcquire(identity.sandboxId);
    if (!release) {
      block(
        socket,
        attempt,
        "connection_limit",
        429,
        "Kobe egress: too many connections",
        "Kobe egress: this sandbox has too many open connections; close some and retry.",
      );
      return;
    }
    try {
      await setUp(socket, head, attempt, target, host);
    } finally {
      release();
    }
  }

  async function setUp(
    socket: Socket,
    head: Buffer,
    attempt: Attempt,
    target: { host: string; port: number } | undefined,
    host: string | null,
  ): Promise<void> {
    const { identity } = attempt;
    if (!target || host === null || isIP(target.host) !== 0) {
      block(
        socket,
        attempt,
        "invalid_target",
        403,
        "Kobe egress blocked: invalid target",
        "Kobe egress: CONNECT needs a host name and port (IP addresses are never allowed).",
      );
      return;
    }
    if (!settings.allowedPorts.includes(target.port)) {
      block(
        socket,
        attempt,
        "port_not_allowed",
        403,
        `Kobe egress blocked: port ${target.port} is not allowed`,
        `Kobe egress: only HTTPS ports ${settings.allowedPorts.join(", ")} are allowed.`,
      );
      return;
    }

    let decision: EgressDecision;
    try {
      if (!(await deps.policy.isActiveMember(identity.teamId, identity.userId))) {
        finish(attempt, "blocked", "inactive_member");
        reply(
          socket,
          403,
          "Kobe egress blocked: not an active team member",
          "Kobe egress: this sandbox's user is not an active member of its team.",
        );
        return;
      }
      decision = await deps.policy.decide(identity.teamId, host);
    } catch (err) {
      logger.error({ err, team: identity.teamId }, "egress allowlist unavailable");
      finish(attempt, "failed", "policy_unavailable");
      reply(
        socket,
        503,
        "Kobe egress: allowlist unavailable",
        "Kobe egress: the allowlist could not be read; try again shortly.",
      );
      return;
    }
    if (!decision.allowed) {
      if (decision.reason === "not_enabled") {
        block(
          socket,
          attempt,
          "not_enabled",
          403,
          `Kobe egress blocked: ${host} is not enabled for this team`,
          `Kobe egress: ${host} is not enabled for this team. A team admin can enable it (Request access).`,
          true,
        );
      } else {
        block(
          socket,
          attempt,
          "not_in_ceiling",
          403,
          `Kobe egress blocked: ${host} is not allowed in this install`,
          `Kobe egress: ${host} is not in this install's egress ceiling; an install admin must add it first.`,
        );
      }
      return;
    }

    // Header injection (KOBE-39): a tunnel can't carry the team's headers; say how to get them.
    let injected: string | undefined;
    try {
      injected = deps.headers
        ? await deps.policy.sealedHeaders?.(identity.teamId, decision.pattern)
        : undefined;
    } catch (err) {
      logger.error({ err, team: identity.teamId }, "egress header rules unavailable");
      finish(attempt, "failed", "policy_unavailable");
      reply(
        socket,
        503,
        "Kobe egress: allowlist unavailable",
        "Kobe egress: the allowlist could not be read; try again shortly.",
      );
      return;
    }
    if (injected !== undefined) {
      finish(attempt, "blocked", "headers_required");
      reply(
        socket,
        403,
        `Kobe egress blocked: use http://${host} (team credentials are injected)`,
        `Kobe egress: your team injects credentials for ${host}. Use http://${host}/... instead of ` +
          "https:// — the proxy adds them and connects over verified HTTPS for you.",
      );
      return;
    }

    const detach = deps.bandwidth.attach(identity.sandboxId);
    let upstream: Socket | undefined;
    try {
      let addresses: string[];
      try {
        addresses = await deps.resolve(host);
      } catch {
        finish(attempt, "failed", "dns_failure");
        reply(
          socket,
          502,
          `Kobe egress: cannot resolve ${host}`,
          `Kobe egress: ${host} does not resolve.`,
        );
        return;
      }
      if (deps.addresses.checkAll(addresses) !== "allowed") {
        block(
          socket,
          attempt,
          "forbidden_address",
          403,
          `Kobe egress blocked: ${host} resolves to an internal address`,
          `Kobe egress: ${host} resolves to an internal or reserved address, which sandboxes may never reach.`,
        );
        return;
      }
      upstream = await firstReachable(
        addresses,
        target.port,
        settings.connectTimeoutMs,
        connectUpstream,
      );
      if (!upstream) {
        finish(attempt, "failed", "upstream_unreachable");
        reply(
          socket,
          502,
          `Kobe egress: cannot connect to ${host}`,
          `Kobe egress: ${host} did not accept a connection.`,
        );
        return;
      }
      if (socket.destroyed) return;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      const hello = await readClientHello(socket, head, settings.handshakeTimeoutMs);
      if (!sniMatches(hello.serverName, host)) {
        // The tunnel is open: no HTTP status can be sent any more, so the connection is cut.
        finish(attempt, "blocked", "sni_mismatch");
        deps.blocked.report({
          teamId: identity.teamId,
          userId: identity.userId,
          sandboxId: identity.sandboxId,
          domain: host,
          port: target.port,
          reason: "sni_mismatch",
          requestAccess: false,
          threadHint: identity.threadHint,
        });
        logger.info(
          { team: identity.teamId, host, why: hello.why },
          "egress tunnel refused: TLS server name does not match",
        );
        socket.destroy();
        return;
      }
      const tunnel = upstream;
      upstream = undefined;
      // Revocation reaches open tunnels: re-checked on change hints, closed at token expiry or
      // the maximum tunnel age, whichever comes first.
      const unregister = deps.tunnels?.register(
        {
          teamId: identity.teamId,
          userId: identity.userId,
          host,
          close: (reason) => {
            logger.info({ team: identity.teamId, host, reason }, "egress tunnel closed by policy");
            socket.destroy();
            tunnel.destroy();
          },
        },
        Math.min(identity.expiresAt, Date.now() + settings.maxTunnelMs),
      );
      try {
        const bytes = await runTunnel({
          client: socket,
          upstream: tunnel,
          initial: hello.bytes,
          throttle: (n) => deps.bandwidth.take(identity.sandboxId, n),
          idleTimeoutMs: settings.idleTimeoutMs,
        });
        finish(attempt, "allowed", undefined, bytes);
      } finally {
        unregister?.();
      }
    } finally {
      upstream?.destroy();
      detach();
    }
  }

  const server = createServer({
    maxHeaderSize: 8192,
    // Request heads must arrive within the pre-auth bound (headersTimeout below); an upgraded
    // plain-HTTP request's body is bounded by its own deadline (upgrade.ts), not this.
    requestTimeout: deps.upgrade
      ? deps.upgrade.timeoutMs + settings.connectTimeoutMs + settings.handshakeTimeoutMs
      : settings.preAuthTimeoutMs,
    // How often Node enforces headersTimeout/requestTimeout (default 30 s): slow-loris bound.
    connectionsCheckingInterval: Math.min(1_000, settings.preAuthTimeoutMs),
  });
  server.headersTimeout = settings.preAuthTimeoutMs;
  if (deps.preauth) {
    const gate = deps.preauth;
    server.on("connection", (socket: Socket) => void gate.admit(socket));
  }
  server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    handleConnect(req, socket, head).catch((err: unknown) => {
      logger.error({ err }, "egress proxy connect handler failed");
      socket.destroy();
    });
  });
  const upgradeContext: UpgradeContext = {
    deps: { ...deps, connectUpstream },
    finish: (a, outcome, reason, bytes, upgraded) => {
      finish(a, outcome, reason, bytes, upgraded);
    },
    report: (a, reason, requestAccess) => {
      if (a.host === undefined) return;
      deps.blocked.report({
        teamId: a.identity.teamId,
        userId: a.identity.userId,
        sandboxId: a.identity.sandboxId,
        domain: a.host,
        port: a.port ?? 80,
        reason,
        requestAccess,
        threadHint: a.identity.threadHint,
      });
    },
    authRefused: (source, reason) => {
      if (authLogs.take(source))
        logger.info({ reason, remote: source }, "egress proxy auth refused");
    },
  };
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (url.startsWith("/")) {
      handleRequest(req, res, deps);
      return;
    }
    // Absolute-form: a plain-HTTP proxy request (KOBE-39 upgrade path, refused otherwise).
    handlePlainHttp(req, res, upgradeContext).catch((err: unknown) => {
      logger.error({ err }, "egress proxy plain-HTTP handler failed");
      res.destroy();
    });
  });
  server.on("clientError", (err: NodeJS.ErrnoException, socket: Socket) => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const status =
      err.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request";
    closeSoon(socket);
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  });
  return server;
}

/** Health endpoints (origin-form requests); absolute-form ones go to upgrade.ts. */
function handleRequest(req: IncomingMessage, res: ServerResponse, deps: ProxyDeps): void {
  const json = (status: number, body: unknown) => {
    // Close after answering: an unauthenticated socket must not linger (pre-auth budget).
    res.writeHead(status, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "";
  if (url.startsWith("/") && req.method === "GET") {
    if (url === "/healthz") return json(200, { status: "ok", service: SERVICE });
    if (url === "/readyz") {
      const ready = deps.ready?.() ?? true;
      return json(ready ? 200 : 503, { status: ready ? "ready" : "draining", service: SERVICE });
    }
    return json(404, { status: "not_found", service: SERVICE });
  }
  json(405, { status: "method_not_allowed", service: SERVICE });
}

/**
 * The TLS server name must be the CONNECT host: compared as a lowercased literal with at most one
 * trailing dot removed, never decoded or IDNA-converted (the host is already canonical ASCII).
 */
export function sniMatches(serverName: string | undefined, host: string): boolean {
  if (serverName === undefined) return false;
  const name = serverName.toLowerCase();
  return (name.endsWith(".") ? name.slice(0, -1) : name) === host;
}

async function firstReachable(
  addresses: readonly string[],
  port: number,
  timeoutMs: number,
  connect: ConnectUpstream,
): Promise<Socket | undefined> {
  // IPv4 first: clusters often have no IPv6 egress.
  const ordered = [...addresses].sort((a, b) => isIP(a) - isIP(b)).slice(0, 3);
  for (const address of ordered) {
    try {
      return await connect(address, port, timeoutMs);
    } catch {
      // try the next address
    }
  }
  return undefined;
}

interface ClientHelloRead {
  readonly bytes: Buffer;
  readonly serverName: string | undefined;
  readonly why?: string;
}

/** Collects the client's first bytes until its ClientHello is complete (or invalid, or too slow). */
function readClientHello(
  socket: Socket,
  head: Buffer,
  timeoutMs: number,
): Promise<ClientHelloRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = head.length > 0 ? [head] : [];
    let size = head.length;
    let done = false;
    const finish = (serverName: string | undefined, why?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
      resolve({ bytes: Buffer.concat(chunks), serverName, ...(why ? { why } : {}) });
    };
    const check = () => {
      const result = parseClientHello(Buffer.concat(chunks));
      if (result.status === "ok") finish(result.serverName);
      else if (result.status === "invalid") finish(undefined, result.why);
      else if (size > MAX_CLIENT_HELLO_BYTES) finish(undefined, "ClientHello too large");
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      check();
    };
    const onClose = () => finish(undefined, "closed before ClientHello");
    const timer = setTimeout(() => finish(undefined, "no ClientHello in time"), timeoutMs);
    socket.on("data", onData);
    socket.once("close", onClose);
    if (size > 0) check();
    if (!done) socket.resume();
  });
}
