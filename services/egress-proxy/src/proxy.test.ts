import { once } from "node:events";
import type { Server } from "node:http";
import {
  connect,
  createServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { signSessionToken } from "@kobe/session-token";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressPolicy } from "./address-policy.js";
import type { EgressDecision } from "./allowlist.js";
import { egressTokenVerifier } from "./auth.js";
import type { BlockedAttempt } from "./blocked-reporter.js";
import type { ConnectionRecord } from "./connection-audit.js";
import { BandwidthLimiter, ConnectionLimits } from "./limits.js";
import { createEgressProxy, parseConnectTarget, tcpConnect, type ProxyDeps } from "./proxy.js";
import { captureClientHello } from "./testing/client-hello.js";

const KEY = "p".repeat(40);
const TEAM = "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
const USER = "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70";
const SANDBOX = "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192";
const THREAD = "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function token(
  aud: "kobe.egress-proxy" | "kobe.mcp-proxy" = "kobe.egress-proxy",
  key = KEY,
): string {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud,
      sub: SANDBOX,
      team_id: TEAM,
      user_id: USER,
      iat: now,
      exp: now + 900,
      jti: "j".repeat(20),
    },
    key,
  );
}
const basic = (user: string, t: string) =>
  `Basic ${Buffer.from(`${user}:${t}`).toString("base64")}`;

/** Upstream stand-in: records what it receives and echoes it back. */
let upstream: NetServer;
let upstreamPort = 0;
let received: Buffer[] = [];
beforeAll(async () => {
  upstream = createServer((s) => {
    s.on("data", (c: Buffer) => {
      received.push(c);
      s.write(c);
    });
    s.on("error", () => undefined);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  upstreamPort = (upstream.address() as AddressInfo).port;
});
afterAll(() => upstream.close());

let hello: Buffer;
let helloOther: Buffer;
beforeAll(async () => {
  hello = await captureClientHello("allowed.example.com");
  helloOther = await captureClientHello("evil.example.net");
});

const ENABLED = new Set([
  "allowed.example.com",
  "internal.example.com",
  "mixed.example.com",
  "rebind.example.com",
]);
const CEILING = new Set([...ENABLED, "pypi.org"]);
const DNS: Record<string, string[]> = {
  "allowed.example.com": ["127.0.0.1"],
  "internal.example.com": ["10.43.0.10"],
  "mixed.example.com": ["127.0.0.1", "169.254.169.254"],
};

let proxy: Server;
let proxyPort = 0;
let audit: ConnectionRecord[];
let blocked: BlockedAttempt[];
let deps: ProxyDeps;
let resolveCalls: string[];
let connectCalls: string[];

async function start(overrides: Partial<ProxyDeps> = {}): Promise<void> {
  audit = [];
  blocked = [];
  received = [];
  resolveCalls = [];
  connectCalls = [];
  let rebinds = 0;
  deps = {
    verify: egressTokenVerifier(KEY),
    policy: {
      decide: async (_team, host): Promise<EgressDecision> =>
        ENABLED.has(host)
          ? { allowed: true, pattern: host }
          : { allowed: false, reason: CEILING.has(host) ? "not_enabled" : "not_in_ceiling" },
      isActiveMember: async () => true,
    },
    resolve: async (host) => {
      resolveCalls.push(host);
      // A rebinding name: public (here: the test upstream) first, internal afterwards.
      if (host === "rebind.example.com") return rebinds++ === 0 ? ["127.0.0.1"] : ["10.0.0.1"];
      const found = DNS[host];
      if (!found) throw new Error("NXDOMAIN");
      return found;
    },
    // 127.0.0.1 stands in for "the internet" here: explicitly allowed as an internal target.
    addresses: new AddressPolicy({ allowedInternal: ["127.0.0.1/32"] }),
    connections: new ConnectionLimits({ perSandbox: 2, total: 100 }),
    bandwidth: new BandwidthLimiter(0),
    audit: { record: (r) => void audit.push(r) },
    blocked: { report: (a) => void blocked.push(a) },
    logger: pino({ level: "silent" }),
    settings: {
      allowedPorts: [443],
      idleTimeoutMs: 5_000,
      handshakeTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    },
    connectUpstream: (address, port, timeoutMs) => {
      connectCalls.push(`${address}:${port}`);
      return tcpConnect(address, port === 443 ? upstreamPort : port, timeoutMs);
    },
    ...overrides,
  };
  proxy = createEgressProxy(deps);
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  proxyPort = (proxy.address() as AddressInfo).port;
}
beforeEach(() => start());
afterEach(async () => {
  proxy.closeAllConnections();
  proxy.close();
});

interface Opened {
  readonly socket: Socket;
  readonly head: string;
}

/** Sends a CONNECT and resolves with the response head (socket left open for the tunnel). */
async function openConnect(target: string, auth?: string): Promise<Opened> {
  const socket = connect(proxyPort, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`,
  );
  let buf = "";
  while (!buf.includes("\r\n\r\n")) {
    const [chunk] = (await Promise.race([
      once(socket, "data"),
      once(socket, "close").then(() => [Buffer.alloc(0)]),
    ])) as [Buffer];
    if (chunk.length === 0) break;
    buf += chunk.toString("latin1");
  }
  return { socket, head: buf };
}

const auth = () => basic("kobe", token());
const status = (head: string) => head.split("\r\n")[0];
const settle = () => new Promise((r) => setTimeout(r, 50));

async function readExactly(socket: Socket, n: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < n) {
    const [c] = (await once(socket, "data")) as [Buffer];
    chunks.push(c);
    size += c.length;
  }
  return Buffer.concat(chunks);
}

describe("authentication", () => {
  it("asks for credentials (407) without a token, a wrong-audience token or a forged one", async () => {
    for (const credentials of [
      undefined,
      `Bearer ${token("kobe.mcp-proxy")}`,
      `Bearer ${token("kobe.egress-proxy", "x".repeat(40))}`,
    ]) {
      const { head } = await openConnect("allowed.example.com:443", credentials);
      expect(status(head)).toBe("HTTP/1.1 407 Proxy Authentication Required");
      expect(head).toContain('Proxy-Authenticate: Basic realm="kobe-egress"');
    }
    expect(audit).toEqual([]);
    expect(resolveCalls).toEqual([]);
  });

  it("refuses a user who is no longer an active member of the token's team", async () => {
    await start({ policy: { ...deps.policy, isActiveMember: async () => false } });
    const { head } = await openConnect("allowed.example.com:443", auth());
    expect(status(head)).toMatch(/^HTTP\/1.1 403 .*not an active team member/);
    expect(connectCalls).toEqual([]);
  });
});

describe("default deny", () => {
  it("blocks a domain the team has not enabled (403, request access offered) and records it", async () => {
    const { head } = await openConnect("pypi.org:443", basic(THREAD, token()));
    expect(status(head)).toBe(
      "HTTP/1.1 403 Kobe egress blocked: pypi.org is not enabled for this team",
    );
    expect(head).toContain("Request access");
    expect(audit).toMatchObject([
      { domain: "pypi.org", outcome: "blocked", reason: "not_enabled", teamId: TEAM },
    ]);
    expect(blocked).toEqual([
      {
        teamId: TEAM,
        userId: USER,
        sandboxId: SANDBOX,
        domain: "pypi.org",
        port: 443,
        reason: "not_enabled",
        requestAccess: true,
        threadHint: THREAD,
      },
    ]);
    expect(resolveCalls).toEqual([]);
  });

  it("blocks a domain outside the install ceiling without offering request access", async () => {
    const { head } = await openConnect("example.org:443", auth());
    expect(status(head)).toMatch(
      /403 Kobe egress blocked: example.org is not allowed in this install/,
    );
    expect(blocked[0]).toMatchObject({ reason: "not_in_ceiling", requestAccess: false });
  });

  it("refuses IP literals, other ports and junk targets before any lookup", async () => {
    for (const [target, reason] of [
      ["127.0.0.1:443", "invalid_target"],
      ["[::1]:443", "invalid_target"],
      ["allowed.example.com:22", "port_not_allowed"],
      ["allowed.example.com", "invalid_target"],
    ] as const) {
      const { head } = await openConnect(target, auth());
      expect(status(head), target).toMatch(/^HTTP\/1.1 403 /);
      expect(audit.at(-1)?.reason, target).toBe(reason);
    }
    expect(resolveCalls).toEqual([]);
    expect(connectCalls).toEqual([]);
  });

  it("refuses plain-HTTP proxy requests (HTTPS only)", async () => {
    const socket = connect(proxyPort, "127.0.0.1");
    socket.write(
      `GET http://allowed.example.com/ HTTP/1.1\r\nHost: allowed.example.com\r\nProxy-Authorization: ${auth()}\r\n\r\n`,
    );
    const [data] = (await once(socket, "data")) as [Buffer];
    expect(data.toString().split("\r\n")[0]).toBe(
      "HTTP/1.1 403 Kobe egress blocked: plain HTTP is not allowed",
    );
    socket.destroy();
    expect(connectCalls).toEqual([]);
  });

  it("fails closed (503) when the allowlist cannot be read", async () => {
    await start({
      policy: { ...deps.policy, decide: async () => Promise.reject(new Error("db down")) },
    });
    const { head } = await openConnect("allowed.example.com:443", auth());
    expect(status(head)).toMatch(/^HTTP\/1.1 503 /);
    expect(audit).toMatchObject([{ outcome: "failed", reason: "policy_unavailable" }]);
  });
});

describe("internal addresses (SSRF, DNS rebinding)", () => {
  it("refuses an allowed name that resolves to a private address", async () => {
    const { head } = await openConnect("internal.example.com:443", auth());
    expect(status(head)).toMatch(
      /403 Kobe egress blocked: internal.example.com resolves to an internal address/,
    );
    expect(connectCalls).toEqual([]);
    expect(blocked[0]).toMatchObject({
      reason: "forbidden_address",
      domain: "internal.example.com",
    });
  });

  it("refuses a name when any of its addresses is internal (metadata endpoint among them)", async () => {
    const { head } = await openConnect("mixed.example.com:443", auth());
    expect(status(head)).toMatch(/^HTTP\/1.1 403 /);
    expect(connectCalls).toEqual([]);
  });

  it("resolves once and connects to the address it checked, so rebinding gains nothing", async () => {
    const { socket, head } = await openConnect("rebind.example.com:443", auth());
    expect(status(head)).toBe("HTTP/1.1 200 Connection Established");
    expect(resolveCalls).toEqual(["rebind.example.com"]);
    expect(connectCalls).toEqual(["127.0.0.1:443"]);
    socket.destroy();
  });

  it("reports names that do not resolve as a failure (502)", async () => {
    ENABLED.add("nxdomain.example.com");
    try {
      const { head } = await openConnect("nxdomain.example.com:443", auth());
      expect(status(head)).toMatch(/^HTTP\/1.1 502 /);
      expect(audit.at(-1)).toMatchObject({ outcome: "failed", reason: "dns_failure" });
    } finally {
      ENABLED.delete("nxdomain.example.com");
    }
  });
});

describe("allowed tunnels", () => {
  it("relays an enabled domain's TLS bytes untouched and logs bytes per connection", async () => {
    const { socket, head } = await openConnect("allowed.example.com:443", auth());
    expect(status(head)).toBe("HTTP/1.1 200 Connection Established");
    socket.write(hello);
    const echoed = await readExactly(socket, hello.length);
    expect(echoed.equals(hello)).toBe(true);
    expect(Buffer.concat(received).equals(hello)).toBe(true);
    socket.end();
    await once(socket, "close");
    await settle();
    expect(audit).toMatchObject([
      {
        domain: "allowed.example.com",
        port: 443,
        outcome: "allowed",
        bytesUp: hello.length,
        bytesDown: hello.length,
      },
    ]);
  });

  it("cuts the tunnel when the TLS server name differs from the CONNECT host", async () => {
    const { socket, head } = await openConnect("allowed.example.com:443", auth());
    expect(status(head)).toBe("HTTP/1.1 200 Connection Established");
    socket.write(helloOther);
    await once(socket, "close");
    await settle();
    expect(received).toEqual([]);
    expect(audit).toMatchObject([{ outcome: "blocked", reason: "sni_mismatch" }]);
  });

  it("cuts tunnels without SNI and tunnels carrying another protocol", async () => {
    const noSni = await captureClientHello(undefined);
    for (const first of [
      noSni,
      Buffer.from("GET / HTTP/1.1\r\nHost: allowed.example.com\r\n\r\n"),
    ]) {
      const { socket } = await openConnect("allowed.example.com:443", auth());
      socket.write(first);
      await once(socket, "close");
    }
    await settle();
    expect(received).toEqual([]);
    expect(audit.map((a) => a.reason)).toEqual(["sni_mismatch", "sni_mismatch"]);
  });

  it("cuts a tunnel whose client never sends a ClientHello", async () => {
    const { socket } = await openConnect("allowed.example.com:443", auth());
    await once(socket, "close");
    expect(received).toEqual([]);
  });
});

describe("limits", () => {
  it("caps concurrent tunnels per sandbox (429) and frees the slot when one closes", async () => {
    const a = await openConnect("allowed.example.com:443", auth());
    const b = await openConnect("allowed.example.com:443", auth());
    const c = await openConnect("allowed.example.com:443", auth());
    expect([a, b, c].map((o) => status(o.head))).toEqual([
      "HTTP/1.1 200 Connection Established",
      "HTTP/1.1 200 Connection Established",
      "HTTP/1.1 429 Kobe egress: too many connections",
    ]);
    a.socket.write(hello);
    await readExactly(a.socket, hello.length);
    a.socket.destroy();
    await settle();
    const d = await openConnect("allowed.example.com:443", auth());
    expect(status(d.head)).toBe("HTTP/1.1 200 Connection Established");
    b.socket.destroy();
    d.socket.destroy();
  });

  it("closes idle tunnels", async () => {
    await start({ settings: { ...deps.settings, idleTimeoutMs: 200 } });
    const { socket } = await openConnect("allowed.example.com:443", auth());
    socket.write(hello);
    await readExactly(socket, hello.length);
    const t0 = Date.now();
    await once(socket, "close");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("throttles a sandbox to its bandwidth", async () => {
    await start({ bandwidth: new BandwidthLimiter(40_000) });
    const { socket } = await openConnect("allowed.example.com:443", auth());
    socket.write(hello);
    await readExactly(socket, hello.length);
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) {
      const payload = Buffer.alloc(10_000, i);
      socket.write(payload);
      await readExactly(socket, payload.length);
    }
    // 120 KB (both directions) through a 40 KB/s bucket with a one-second burst: about 2 s.
    expect(Date.now() - t0).toBeGreaterThan(1_000);
    socket.destroy();
  }, 15_000);
});

describe("health", () => {
  it("serves /healthz and /readyz", async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
    expect(await res.json()).toEqual({ status: "ok", service: "egress-proxy" });
    expect((await fetch(`http://127.0.0.1:${proxyPort}/readyz`)).status).toBe(200);
  });
});

describe("parseConnectTarget", () => {
  it("parses host:port and bracketed IPv6, and rejects junk", () => {
    expect(parseConnectTarget("pypi.org:443")).toEqual({ host: "pypi.org", port: 443 });
    expect(parseConnectTarget("[::1]:443")).toEqual({ host: "::1", port: 443 });
    for (const bad of [
      "pypi.org",
      ":443",
      "pypi.org:0",
      "pypi.org:99999",
      "pypi.org:44a",
      undefined,
    ]) {
      expect(parseConnectTarget(bad), String(bad)).toBeUndefined();
    }
  });
});

vi.setConfig({ testTimeout: 10_000 });
