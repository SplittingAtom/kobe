import { describe, expect, it } from "vitest";
import { SessionClient, sessionUrl } from "./exchange.js";

const SANDBOX = "af1a2b3c-4d5e-4f60-9182-93a4b5c6d7e8";
const TEAM = "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
const USER = "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70";

const token = (aud: string, n = 0) => `${aud}.${"x".repeat(30)}.${n}`;
const grantBody = (expiresAt: number, n = 0) => ({
  sandbox_id: SANDBOX,
  team_id: TEAM,
  user_id: USER,
  expires_at: new Date(expiresAt).toISOString(),
  tokens: {
    "kobe.sandbox-wire": token("wire", n),
    "kobe.model-gateway": token("gw", n),
    "kobe.mcp-proxy": token("mcp", n),
    "kobe.egress-proxy": token("egress", n),
  },
});

type Step = Response | Error;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function harness(steps: Step[], opts: { file?: () => string; random?: () => number } = {}) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const requests: { url: string; auth: string | null; timeout: boolean }[] = [];
  const logs: unknown[] = [];
  const client = new SessionClient({
    serverUrl: "ws://server.kobe.internal:8081",
    bootstrapTokenFile: "/var/run/secrets/kobe/bootstrap-token",
    readFile: async () => (opts.file ?? (() => "bootstrap-token-value\n"))(),
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({
        url,
        auth: new Headers(init.headers).get("authorization"),
        timeout: init.signal instanceof AbortSignal,
      });
      const step = steps.shift();
      if (!step) throw new Error("no more steps");
      if (step instanceof Error) throw step;
      return step;
    }) as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: opts.random ?? (() => 0.5),
    logger: {
      info: (o: unknown) => void logs.push(o),
      warn: (o: unknown) => void logs.push(o),
      debug: () => {},
      error: (o: unknown) => void logs.push(o),
    } as never,
  });
  return {
    client,
    sleeps,
    requests,
    logs,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

describe("sessionUrl", () => {
  it("maps the wire URL to the session endpoint on the same listener", () => {
    expect(sessionUrl("ws://server.kobe.internal:8081")).toBe(
      "http://server.kobe.internal:8081/v1/sandbox/session",
    );
    expect(sessionUrl("wss://kobe/x?y=1")).toBe("https://kobe/v1/sandbox/session");
  });
});

describe("SessionClient (bootstrap → session tokens)", () => {
  it("trades the bootstrap token and hands out the wire token", async () => {
    const h = harness([json(200, grantBody(1_000_000 + 900_000))]);
    await expect(h.client.wireToken()).resolves.toBe(token("wire"));
    expect(h.requests[0]).toEqual({
      url: "http://server.kobe.internal:8081/v1/sandbox/session",
      auth: "Bearer bootstrap-token-value",
      timeout: true,
    });
    expect((await h.client.grant()).sandboxId).toBe(SANDBOX);
  });

  it("retries quickly while the network is not ready yet (cold start), then succeeds", async () => {
    const h = harness([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      json(200, grantBody(1_000_000 + 900_000)),
    ]);
    await h.client.wireToken();
    expect(h.sleeps).toEqual([200, 200]);
  });

  it("jitters the fast retries (100–300 ms)", async () => {
    const randoms = [0, 0.999];
    const h = harness(
      [
        new TypeError("fetch failed"),
        new TypeError("fetch failed"),
        json(200, grantBody(1_000_000 + 900_000)),
      ],
      { random: () => randoms.shift() ?? 0.5 },
    );
    await h.client.wireToken();
    expect(h.sleeps).toEqual([100, 300]);
  });

  it("backs off with jitter once the fast-retry window has passed", async () => {
    const steps: Step[] = Array.from({ length: 200 }, () => new TypeError("fetch failed"));
    steps.push(json(200, grantBody(1_000_000 + 10_000_000)));
    const h = harness(steps);
    await h.client.wireToken();
    expect(h.sleeps.slice(0, 3)).toEqual([200, 200, 200]);
    expect(Math.max(...h.sleeps)).toBeGreaterThan(200);
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(30_000);
  });

  it("waits as told while a warm-pool pod is unassigned (409) or rate limited (429)", async () => {
    const h = harness([
      json(409, { code: "sandbox_unassigned", retry_after_ms: 2000 }),
      json(429, { code: "rate_limited" }, { "retry-after": "3" }),
      json(200, grantBody(1_000_000 + 900_000)),
    ]);
    await h.client.wireToken();
    expect(h.sleeps).toEqual([2000, 3000]);
  });

  it("re-reads the rotated bootstrap token on every attempt", async () => {
    let n = 0;
    const h = harness(
      [json(401, { code: "unauthorized" }), json(200, grantBody(1_000_000 + 900_000))],
      { file: () => `bootstrap-${n++}` },
    );
    await h.client.wireToken();
    expect(h.requests.map((r) => r.auth)).toEqual(["Bearer bootstrap-0", "Bearer bootstrap-1"]);
  });

  it("reuses the grant until it nears expiry, then trades again (once for concurrent callers)", async () => {
    const h = harness([
      json(200, grantBody(1_000_000 + 900_000, 1)),
      json(200, grantBody(1_000_000 + 1_800_000, 2)),
    ]);
    await expect(h.client.wireToken()).resolves.toBe(token("wire", 1));
    h.advance(600_000);
    await expect(h.client.wireToken()).resolves.toBe(token("wire", 1));
    h.advance(200_000); // within the 2-minute margin
    const [a, b] = await Promise.all([h.client.wireToken(), h.client.wireToken()]);
    expect([a, b]).toEqual([token("wire", 2), token("wire", 2)]);
    expect(h.requests).toHaveLength(2);
  });

  it("rejects a malformed answer and retries; never logs a token", async () => {
    const h = harness([
      json(200, { sandbox_id: "nope" }),
      json(200, grantBody(1_000_000 + 900_000)),
    ]);
    await h.client.wireToken();
    expect(JSON.stringify(h.logs)).not.toMatch(/bootstrap-token-value|x{30}/);
  });
});
