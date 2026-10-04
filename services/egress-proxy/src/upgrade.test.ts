import { once } from "node:events";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { signSessionToken } from "@kobe/session-token";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AddressPolicy } from "./address-policy.js";
import type { EgressDecision } from "./allowlist.js";
import { egressTokenVerifier } from "./auth.js";
import type { BlockedAttempt } from "./blocked-reporter.js";
import type { ConnectionRecord } from "./connection-audit.js";
import { BandwidthLimiter, ConnectionLimits } from "./limits.js";
import { createEgressProxy, tcpConnect, type ProxyDeps } from "./proxy.js";
import { selfSignedCert } from "./testing/tls-cert.js";
import { TunnelRegistry } from "./tunnel-registry.js";
import {
  downstreamHeaders,
  parsePlainTarget,
  rewriteLocation,
  upstreamHeaders,
} from "./upgrade.js";

/** KOBE-39: plain HTTP for header-injected domains, upgraded to verified HTTPS by the proxy. */
const KEY = "p".repeat(40);
const TEAM = "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
const USER = "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70";
const SANDBOX = "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192";
const SECRET = "Bearer team-secret-0123456789";

function token(): string {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: "kobe.egress-proxy",
      sub: SANDBOX,
      team_id: TEAM,
      user_id: USER,
      iat: now,
      exp: now + 900,
      jti: "j".repeat(20),
    },
    KEY,
  );
}
const proxyAuth = () => `Basic ${Buffer.from(`kobe:${token()}`).toString("base64")}`;

interface Seen {
  readonly path: string;
  readonly method: string;
  readonly headers: IncomingHttpHeaders;
  readonly servername: string | false | null;
  readonly body: string;
}

const certs = {
  good: selfSignedCert("pkgs.example.com"),
  wrongName: selfSignedCert("other.example.com"),
};
let upstreams: HttpsServer[] = [];
const ports: Record<string, number> = {};
let seen: Seen[] = [];

async function upstream(cert: { key: string; cert: string }): Promise<number> {
  const server = createHttpsServer({ ...cert }, (req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({
        path: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        servername: (req.socket as TLSSocket).servername,
        body,
      });
      if (req.url === "/redirect-same") {
        res.writeHead(302, { location: "https://pkgs.example.com/simple/next/" });
        res.end();
      } else if (req.url === "/redirect-other") {
        res.writeHead(302, { location: "https://cdn.example.org/file.whl" });
        res.end();
      } else if (req.url === "/echo-secret") {
        res.writeHead(200, { "x-debug": `auth=${req.headers.authorization ?? ""}`, "x-ok": "1" });
        res.end("ok");
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-length": String(10_000) });
        res.end("x".repeat(10_000));
      } else if (req.url === "/stream-big") {
        res.writeHead(200);
        res.end("y".repeat(10_000));
      } else if (req.url === "/hang") {
        // never answers
      } else {
        res.writeHead(200, {
          "content-type": "text/plain",
          connection: "keep-alive, x-hop",
          "x-hop": "1",
        });
        res.end(`hello ${req.method} ${req.url}`);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  upstreams.push(server);
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  ports.good = await upstream(certs.good);
  ports.wrongName = await upstream(certs.wrongName);
});
afterAll(() => {
  for (const s of upstreams) {
    s.closeAllConnections();
    s.close();
  }
  upstreams = [];
});

const ENABLED: Record<string, string> = {
  "pkgs.example.com": "pkgs.example.com",
  "plain.example.com": "plain.example.com",
  "mitm.example.com": "mitm.example.com",
  "internal.example.com": "internal.example.com",
};
const HEADERS: Record<string, string> = {
  "pkgs.example.com": "sealed-pkgs",
  "mitm.example.com": "sealed-mitm",
  "internal.example.com": "sealed-internal",
};
const DNS: Record<string, string[]> = {
  "pkgs.example.com": ["127.0.0.1"],
  "plain.example.com": ["127.0.0.1"],
  "mitm.example.com": ["127.0.0.2"],
  "internal.example.com": ["10.43.0.10"],
};

let proxy: Server;
let proxyPort = 0;
let audit: ConnectionRecord[];
let blocked: BlockedAttempt[];
let connectCalls: string[];
let deps: ProxyDeps;

async function start(
  overrides: Partial<ProxyDeps> = {},
  omit: readonly ("headers" | "upgrade")[] = [],
): Promise<void> {
  if (proxy?.listening) {
    proxy.closeAllConnections();
    proxy.close();
  }
  audit = [];
  blocked = [];
  seen = [];
  connectCalls = [];
  const policy = {
    decide: async (_team: string, host: string): Promise<EgressDecision> => {
      const pattern = ENABLED[host];
      return pattern
        ? { allowed: true, pattern }
        : { allowed: false, reason: host === "pypi.org" ? "not_enabled" : "not_in_ceiling" };
    },
    isActiveMember: async () => true,
    sealedHeaders: async (_team: string, pattern: string) => HEADERS[pattern],
  };
  deps = {
    verify: egressTokenVerifier(KEY),
    policy,
    resolve: async (host) => {
      const found = DNS[host];
      if (!found) throw new Error("NXDOMAIN");
      return found;
    },
    addresses: new AddressPolicy({ allowedInternal: ["127.0.0.0/8"] }),
    connections: new ConnectionLimits({ perSandbox: 4, total: 100 }),
    bandwidth: new BandwidthLimiter(0),
    audit: { record: (r) => void audit.push(r) },
    blocked: { report: (a) => void blocked.push(a) },
    logger: pino({ level: "silent" }),
    settings: {
      allowedPorts: [443],
      idleTimeoutMs: 5_000,
      handshakeTimeoutMs: 1_000,
      preAuthTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
      maxTunnelMs: 60_000,
    },
    connectUpstream: (address, port, timeoutMs) => {
      connectCalls.push(`${address}:${port}`);
      // 127.0.0.2 stands in for an attacker's server (a certificate for another name).
      const target = address === "127.0.0.2" ? ports.wrongName : ports.good;
      return tcpConnect("127.0.0.1", port === 443 ? (target ?? 0) : port, timeoutMs);
    },
    headers: {
      open: (_team, pattern, sealed) => {
        if (sealed !== `sealed-${pattern.split(".")[0]}`) throw new Error("does not open");
        return [
          { name: "Authorization", value: SECRET },
          { name: "X-Org", value: "finance" },
        ];
      },
    },
    upgrade: { maxRequestBytes: 1_000, maxResponseBytes: 5_000, timeoutMs: 1_500 },
    upstreamCa: [certs.good.cert, certs.wrongName.cert],
    tunnels: new TunnelRegistry(policy, pino({ level: "silent" })),
    ...overrides,
  };
  deps = Object.fromEntries(
    Object.entries(deps).filter(([key]) => !omit.includes(key as "headers" | "upgrade")),
  ) as unknown as ProxyDeps;
  proxy = createEgressProxy(deps);
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  proxyPort = (proxy.address() as AddressInfo).port;
}
beforeEach(() => start());
afterEach(() => {
  proxy.closeAllConnections();
  proxy.close();
});

interface Answer {
  readonly status: number;
  readonly message: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A plain-HTTP proxy request, as curl/pip send it with HTTP_PROXY set. */
function viaProxy(
  url: string,
  options: {
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    auth?: string | null;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: proxyPort,
      method: options.method ?? "GET",
      path: url,
      headers: {
        ...(options.auth === null ? {} : { "proxy-authorization": options.auth ?? proxyAuth() }),
        ...options.headers,
      },
      agent: false,
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          message: res.statusMessage ?? "",
          headers: res.headers,
          body,
        }),
      );
      res.on("error", reject);
      res.on("aborted", () =>
        resolve({ status: res.statusCode ?? 0, message: "aborted", headers: res.headers, body }),
      );
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("upgrade (plain HTTP → verified HTTPS with the team's headers)", () => {
  it("injects the team's headers over verified TLS (SNI = host), strips client copies and proxy credentials", async () => {
    const res = await viaProxy("http://pkgs.example.com/simple/?q=1", {
      headers: {
        authorization: "Bearer from-the-sandbox",
        "x-client": "pip",
        "proxy-connection": "keep-alive",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello GET /simple/?q=1");
    expect(seen).toHaveLength(1);
    const got = seen[0] as Seen;
    expect(got.servername).toBe("pkgs.example.com");
    expect(got.headers.host).toBe("pkgs.example.com");
    expect(got.headers.authorization).toBe(SECRET);
    expect(got.headers["x-org"]).toBe("finance");
    expect(got.headers["x-client"]).toBe("pip");
    expect(got.headers["proxy-authorization"]).toBeUndefined();
    expect(got.headers["proxy-connection"]).toBeUndefined();
    // Hop-by-hop response headers (and those listed in Connection) are not relayed, and the
    // connection closes after the response (no idle authenticated sockets).
    expect(res.headers["x-hop"]).toBeUndefined();
    expect(res.headers.connection).toBe("close");
    expect(connectCalls).toEqual(["127.0.0.1:443"]);
    expect(audit).toMatchObject([
      { outcome: "allowed", domain: "pkgs.example.com", port: 80, upgraded: true },
    ]);
    expect((audit[0]?.bytesDown ?? 0) > 0).toBe(true);
  });

  it("relays request bodies (uploads) within the limit", async () => {
    const res = await viaProxy("http://pkgs.example.com/upload", {
      method: "POST",
      body: "payload",
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "POST", body: "payload" });
    expect(audit[0]?.bytesUp).toBe(7);
  });

  it("refuses an upstream whose certificate does not name the host; the headers are never sent", async () => {
    const res = await viaProxy("http://mitm.example.com/simple/");
    expect(res.status).toBe(502);
    expect(res.message).toMatch(/TLS could not be verified/);
    expect(seen).toEqual([]);
    expect(audit).toMatchObject([{ outcome: "failed", reason: "upstream_tls" }]);
  });

  it("keeps plain HTTP refused for enabled domains without injected headers", async () => {
    const res = await viaProxy("http://plain.example.com/");
    expect(res.status).toBe(403);
    expect(res.message).toBe("Kobe egress blocked: plain HTTP is not allowed");
    expect(connectCalls).toEqual([]);
    expect(audit).toMatchObject([{ outcome: "blocked", reason: "plain_http" }]);
  });

  it("blocks a not-enabled domain like CONNECT does (request access offered)", async () => {
    const res = await viaProxy("http://pypi.org/simple/");
    expect(res.status).toBe(403);
    expect(res.message).toMatch(/pypi.org is not enabled for this team/);
    expect(blocked).toMatchObject([
      { domain: "pypi.org", reason: "not_enabled", requestAccess: true },
    ]);
  });

  it("applies the private-address rule (no connection, no headers)", async () => {
    const res = await viaProxy("http://internal.example.com/");
    expect(res.status).toBe(403);
    expect(res.message).toMatch(/internal address/);
    expect(connectCalls).toEqual([]);
  });

  it("asks for the token (407) and refuses ports, IP literals and URL credentials", async () => {
    expect((await viaProxy("http://pkgs.example.com/", { auth: null })).status).toBe(407);
    for (const url of [
      "http://pkgs.example.com:8080/",
      "http://127.0.0.1/",
      "http://user:pw@pkgs.example.com/",
    ]) {
      const res = await viaProxy(url);
      expect(res.status, url).toBe(403);
    }
    expect(seen).toEqual([]);
  });

  it("rewrites a redirect to the same host's https URL into http; another host's is passed on", async () => {
    const same = await viaProxy("http://pkgs.example.com/redirect-same");
    expect(same.status).toBe(302);
    expect(same.headers.location).toBe("http://pkgs.example.com/simple/next/");
    const other = await viaProxy("http://pkgs.example.com/redirect-other");
    expect(other.headers.location).toBe("https://cdn.example.org/file.whl");
  });

  it("drops a response header that echoes an injected value", async () => {
    const res = await viaProxy("http://pkgs.example.com/echo-secret");
    expect(res.status).toBe(200);
    expect(res.headers["x-debug"]).toBeUndefined();
    expect(res.headers["x-ok"]).toBe("1");
  });

  it("enforces size limits both ways and the time limit", async () => {
    const tooBig = await viaProxy("http://pkgs.example.com/upload", {
      method: "POST",
      body: "z".repeat(2_000),
    });
    expect(tooBig.status).toBe(413);
    expect(seen).toEqual([]);
    const declared = await viaProxy("http://pkgs.example.com/big");
    expect(declared.status).toBe(502);
    expect(declared.message).toMatch(/response too large/);
    const streamed = await viaProxy("http://pkgs.example.com/stream-big").catch(() => undefined);
    expect(streamed === undefined || streamed.body.length < 10_000).toBe(true);
    const hang = await viaProxy("http://pkgs.example.com/hang");
    expect(hang.status).toBe(504);
    for (let i = 0; i < 50 && !audit.some((a) => a.reason === "upstream_timeout"); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(audit.map((a) => a.reason)).toEqual(
      expect.arrayContaining(["request_too_large", "response_too_large", "upstream_timeout"]),
    );
  });

  it("refuses CONNECT to a header-injected domain, pointing at http://", async () => {
    const socket = connect(proxyPort, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      `CONNECT pkgs.example.com:443 HTTP/1.1\r\nHost: pkgs.example.com:443\r\nProxy-Authorization: ${proxyAuth()}\r\n\r\n`,
    );
    const [data] = (await once(socket, "data")) as [Buffer];
    socket.destroy();
    expect(data.toString().split("\r\n")[0]).toBe(
      "HTTP/1.1 403 Kobe egress blocked: use http://pkgs.example.com (team credentials are injected)",
    );
    expect(connectCalls).toEqual([]);
    expect(audit).toMatchObject([{ outcome: "blocked", reason: "headers_required" }]);
  });

  it("refuses plain HTTP everywhere when header injection is off", async () => {
    await start({}, ["headers", "upgrade"]);
    const res = await viaProxy("http://pkgs.example.com/simple/");
    expect(res.status).toBe(403);
    expect(connectCalls).toEqual([]);
  });

  it("answers 503 (no request upstream) when the team's headers do not open", async () => {
    await start({
      headers: {
        open: () => {
          throw new Error("wrong secret");
        },
      },
    });
    const res = await viaProxy("http://pkgs.example.com/simple/");
    expect(res.status).toBe(503);
    expect(seen).toEqual([]);
  });
});

describe("upgrade helpers", () => {
  it("parses only http:// absolute URLs to host names on the default port", () => {
    expect(parsePlainTarget("http://PKGS.example.com/a?b")).toEqual({
      ok: true,
      target: { host: "pkgs.example.com", path: "/a?b" },
    });
    expect(parsePlainTarget("http://pkgs.example.com:80/")).toMatchObject({ ok: true });
    for (const bad of [
      "https://x.com/",
      "http://[::1]/",
      "http://10.0.0.1/",
      "ftp://x.com/",
      "/x",
    ]) {
      expect(parsePlainTarget(bad).ok, bad).toBe(false);
    }
  });

  it("builds upstream headers: Host first, client copies of injected names and hop-by-hop dropped", () => {
    const out = upstreamHeaders(
      [
        "Host",
        "evil.example.com",
        "authorization",
        "x",
        "Connection",
        "close, X-Secret-Hop",
        "X-Secret-Hop",
        "1",
        "Proxy-Authorization",
        "Basic abc",
        "Accept",
        "*/*",
      ],
      "pkgs.example.com",
      [{ name: "Authorization", value: "Bearer t" }],
      undefined,
    );
    expect(out).toEqual([
      ["Host", "pkgs.example.com"],
      ["Accept", "*/*"],
      ["Authorization", "Bearer t"],
    ]);
  });

  it("rewrites same-host https locations only", () => {
    expect(rewriteLocation("/next", "pkgs.example.com")).toBe("http://pkgs.example.com/next");
    expect(rewriteLocation("https://pkgs.example.com:443/a#f", "pkgs.example.com")).toBe(
      "http://pkgs.example.com/a#f",
    );
    expect(rewriteLocation("https://pkgs.example.com:8443/a", "pkgs.example.com")).toBe(
      "https://pkgs.example.com:8443/a",
    );
    expect(rewriteLocation("https://other.example.com/a", "pkgs.example.com")).toBe(
      "https://other.example.com/a",
    );
  });

  it("drops response headers carrying an injected value", () => {
    expect(
      downstreamHeaders(["X-A", "has Bearer t0k3n inside", "X-B", "fine"], "h.example.com", [
        { name: "Authorization", value: "Bearer t0k3n" },
      ]),
    ).toEqual([["X-B", "fine"]]);
  });
});
