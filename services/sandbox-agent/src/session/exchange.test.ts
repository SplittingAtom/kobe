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
  const prefers: (string | null)[] = [];
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
      const prefer = new Headers(init.headers).get("prefer");
      prefers.push(prefer);
      const step = steps.shift();
      if (!step) throw new Error("no more steps");
      if (step instanceof Error) throw step;
      // A server holding the request (long-poll) answers after the wait it applied.
      const applied = /wait=(\d+)/.exec(step.headers.get("preference-applied") ?? "");
      if (applied?.[1]) clock += Number(applied[1]) * 1000;
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
    prefers,
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

  it("waits as told while rate limited (429)", async () => {
    const h = harness([
      json(429, { code: "rate_limited" }, { "retry-after": "3" }),
      json(200, grantBody(1_000_000 + 900_000)),
    ]);
    await h.client.wireToken();
    expect(h.sleeps).toEqual([3000]);
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

const unassigned = (applied?: number) =>
  json(
    409,
    { code: "sandbox_unassigned", retry_after_ms: applied === undefined ? 2000 : 250 },
    applied === undefined ? {} : { "preference-applied": `wait=${applied}` },
  );

describe("SessionClient while its warm-pool pod is unassigned (KOBE-417)", () => {
  it("switches to a long-poll (Prefer: wait) after the first unassigned answer", async () => {
    const h = harness([
      unassigned(),
      unassigned(20),
      unassigned(20),
      json(200, grantBody(1_000_000 + 10_000_000)),
    ]);
    await h.client.wireToken();
    expect(h.prefers).toEqual([null, "wait=20", "wait=20", "wait=20"]);
    // Straight into the long-poll, then right back after each held answer.
    expect(h.sleeps).toEqual([200, 250, 250]);
  });

  it("asks again within ~0.3 s of a held answer, so claim → ready is bounded by the server's recheck", async () => {
    const steps: Step[] = [unassigned()];
    for (let i = 0; i < 30; i++) steps.push(unassigned(20));
    steps.push(json(200, grantBody(1_000_000 + 10_000_000)));
    const h = harness(steps, { random: () => 0.999 });
    await h.client.wireToken();
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(300);
    // ~10 min idle → 31 requests (was ~300 at one per 2 s).
    expect(h.requests).toHaveLength(32);
  });

  it("backs off exponentially, with jitter, to a cap when the server does not hold the request", async () => {
    const steps: Step[] = Array.from({ length: 12 }, () => unassigned());
    steps.push(json(200, grantBody(1_000_000 + 10_000_000)));
    const h = harness(steps);
    await h.client.wireToken();
    expect(h.sleeps).toEqual([
      200, 2000, 3000, 6000, 12_000, 24_000, 45_000, 45_000, 45_000, 45_000, 45_000, 45_000,
    ]);
    const capped = harness(
      [
        unassigned(),
        ...Array.from({ length: 9 }, () => unassigned()),
        json(200, grantBody(1_000_000 + 10_000_000)),
      ],
      {
        random: () => 0.999,
      },
    );
    await capped.client.wireToken();
    expect(Math.max(...capped.sleeps)).toBeLessThanOrEqual(60_000);
    expect(Math.max(...capped.sleeps)).toBeGreaterThan(55_000);
  });

  it("retries promptly after a network error even after a long unassigned wait", async () => {
    const steps: Step[] = [unassigned()];
    for (let i = 0; i < 10; i++) steps.push(unassigned(20));
    steps.push(new TypeError("fetch failed"), json(200, grantBody(1_000_000 + 10_000_000)));
    const h = harness(steps);
    await h.client.wireToken();
    expect(h.sleeps.at(-1)).toBeLessThanOrEqual(500);
  });
});

describe("SessionClient after a rejected session token (KOBE-522)", () => {
  const LIFE = 900_000;
  const infos = (h: ReturnType<typeof harness>) =>
    h.logs.filter((l) => (l as { audience?: string }).audience !== undefined);

  it("drops the cached grant and trades the bootstrap token again at once, telling listeners", async () => {
    const h = harness([
      json(200, grantBody(1_000_000 + LIFE, 1)),
      json(200, grantBody(1_000_000 + LIFE, 2)),
    ]);
    const seen: string[] = [];
    h.client.onGrant((g) => seen.push(g.tokens["kobe.model-gateway"]));
    await expect(h.client.wireToken()).resolves.toBe(token("wire", 1));
    h.advance(5_000);
    expect(h.client.rejected("kobe.sandbox-wire", "wire upgrade refused: HTTP 401")).toBe(true);
    await expect(h.client.wireToken()).resolves.toBe(token("wire", 2));
    await expect(h.client.modelGatewayGrant()).resolves.toMatchObject({ token: token("gw", 2) });
    expect(h.requests).toHaveLength(2);
    expect(seen).toEqual([token("gw", 1), token("gw", 2)]);
    expect(infos(h)).toEqual([
      expect.objectContaining({
        audience: "kobe.sandbox-wire",
        reason: "wire upgrade refused: HTTP 401",
      }),
    ]);
    expect(JSON.stringify(h.logs)).not.toMatch(/x{30}/);
  });

  it("ignores a rejection of a token that was already replaced", async () => {
    const h = harness([
      json(200, grantBody(1_000_000 + LIFE, 1)),
      json(200, grantBody(1_000_000 + LIFE, 2)),
    ]);
    await h.client.wireToken();
    expect(h.client.rejected("kobe.model-gateway", "401", token("gw", 1))).toBe(true);
    await h.client.wireToken();
    h.advance(60_000);
    expect(h.client.rejected("kobe.model-gateway", "401", token("gw", 1))).toBe(false);
    expect(h.requests).toHaveLength(2);
  });

  it("re-trades at most once per 30 s and warns once when the limit holds one back", async () => {
    const steps = [1, 2, 3].map((n) => json(200, grantBody(1_000_000 + 10 * LIFE, n)));
    const h = harness(steps);
    await h.client.wireToken();
    expect(h.client.rejected("kobe.sandbox-wire", "401")).toBe(true);
    await h.client.wireToken();
    h.advance(10_000);
    expect(h.client.rejected("kobe.mcp-proxy", "401")).toBe(false);
    expect(h.client.rejected("kobe.egress-proxy", "401")).toBe(false);
    await expect(h.client.wireToken()).resolves.toBe(token("wire", 2));
    expect(h.requests).toHaveLength(2);
    const warns = h.logs.filter((l) => (l as { retry_in_ms?: number }).retry_in_ms !== undefined);
    expect(warns).toEqual([
      expect.objectContaining({ audience: "kobe.mcp-proxy", retry_in_ms: 20_000 }),
    ]);
    h.advance(20_000);
    expect(h.client.rejected("kobe.sandbox-wire", "401")).toBe(true);
    await expect(h.client.wireToken()).resolves.toBe(token("wire", 3));
  });

  it("backs off exponentially to 5 min while the server keeps refusing, so it never loops hot", async () => {
    const steps = Array.from({ length: 30 }, (_, n) =>
      json(200, grantBody(1_000_000 + 100 * LIFE, n)),
    );
    const h = harness(steps);
    await h.client.wireToken();
    const gaps: number[] = [];
    let last = h.now();
    // A permanently rejected token: something calls rejected() every second for an hour.
    for (let s = 0; s < 3_600; s++) {
      if (h.client.rejected("kobe.sandbox-wire", "401")) {
        gaps.push(h.now() - last);
        last = h.now();
        await h.client.wireToken();
      }
      h.advance(1_000);
    }
    expect(gaps.slice(1, 6)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
    expect(h.requests.length).toBeLessThanOrEqual(20);
  });

  it("starts the backoff over once a grant has been quiet for 10 min", async () => {
    const steps = Array.from({ length: 6 }, (_, n) =>
      json(200, grantBody(1_000_000 + 100 * LIFE, n)),
    );
    const h = harness(steps);
    await h.client.wireToken();
    expect(h.client.rejected("kobe.sandbox-wire", "401")).toBe(true);
    await h.client.wireToken();
    h.advance(30_000);
    expect(h.client.rejected("kobe.sandbox-wire", "401")).toBe(true); // next gap: 60 s
    await h.client.wireToken();
    h.advance(700_000);
    expect(h.client.rejected("kobe.sandbox-wire", "401")).toBe(true);
    await h.client.wireToken();
    h.advance(30_000);
    expect(h.client.rejected("kobe.sandbox-wire", "401")).toBe(true);
  });

  it("goes straight to the backoff schedule while the server refuses a re-trade (no fast retries)", async () => {
    const refused = () => json(401, { code: "unauthorized" });
    const h = harness([
      json(200, grantBody(1_000_000 + LIFE, 1)),
      refused(),
      refused(),
      refused(),
      refused(),
      json(200, grantBody(1_000_000 + 2 * LIFE, 2)),
    ]);
    await h.client.wireToken();
    expect(h.client.rejected("kobe.sandbox-wire", "401")).toBe(true);
    await expect(h.client.wireToken()).resolves.toBe(token("wire", 2));
    // random 0.5: DEFAULT_BACKOFF ceilings 500, 1000, 2000, 4000 halved; never the 200 ms fast retry
    expect(h.sleeps).toEqual([250, 500, 1_000, 2_000]);
  });

  it("keeps the new grant when a listener throws", async () => {
    const h = harness([json(200, grantBody(1_000_000 + LIFE, 1))]);
    h.client.onGrant(() => {
      throw new Error("listener bug");
    });
    await expect(h.client.wireToken()).resolves.toBe(token("wire", 1));
    expect(h.logs).toContainEqual(expect.objectContaining({ err: "listener bug" }));
  });
});
