import { InMemorySpanExporter, initTelemetry, type Telemetry } from "@kobe/telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createRateLimiter } from "../sandbox/rate-limit.js";
import { IsolationRuntimeMissingError } from "../isolation/gate.js";
import type { BootstrapIdentity } from "../sandbox/provider.js";
import { SandboxAuthError } from "../sandbox/provider.js";
import { verifySessionToken } from "../sandbox/session-token.js";
import { SESSION_WAIT, createSandboxApp } from "./sandbox.js";
import { KEYS, TEAM, USER, must } from "../testing/sandbox-fixtures.js";

const SANDBOX_ID = "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192";
const ASSIGNED: BootstrapIdentity = {
  state: "assigned",
  principal: { sandboxId: SANDBOX_ID, teamId: TEAM.id, userId: USER },
  namespace: "kobe-team-finance",
  podName: "u-x",
};

function app(identify: (token: string) => Promise<BootstrapIdentity>) {
  return createSandboxApp({ provider: { identifyBootstrapToken: identify }, sessionKeys: KEYS });
}

const post = (a: ReturnType<typeof app>, headers: Record<string, string> = {}) =>
  a.request("/v1/sandbox/session", {
    method: "POST",
    headers: { authorization: "Bearer bootstrap.token.value", ...headers },
  });

describe("POST /v1/sandbox/session", () => {
  it("trades a sandbox's bootstrap token for one session token per audience", async () => {
    let seen = "";
    const res = await post(
      app(async (t) => {
        seen = t;
        return ASSIGNED;
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      sandbox_id: string;
      team_id: string;
      user_id: string;
      expires_at: string;
      tokens: Record<string, string>;
    };
    expect(seen).toBe("bootstrap.token.value");
    expect(body).toMatchObject({ sandbox_id: SANDBOX_ID, team_id: TEAM.id, user_id: USER });
    for (const [aud, key] of Object.entries(KEYS)) {
      const claims = verifySessionToken(must(body.tokens[aud]), aud as keyof typeof KEYS, key);
      expect(claims.sub).toBe(SANDBOX_ID);
    }
  });

  it("asks an unclaimed warm-pool pod to retry", async () => {
    const res = await post(
      app(async () => ({ state: "unassigned", namespace: "kobe-team-finance", podName: "w" })),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "sandbox_unassigned", retry_after_ms: 2000 });
  });

  it("refuses requests without a bearer token", async () => {
    const res = await app(async () => ASSIGNED).request("/v1/sandbox/session", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("refuses tokens that are not a live sandbox's, without detail", async () => {
    const res = await post(
      app(async () => {
        throw new SandboxAuthError("pod kobe-team-x/y is gone");
      }),
    );
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toMatch(/kobe-team-x/);
  });

  it("returns isolation_runtime_missing (503) via toResponseBody()", async () => {
    const res = await post(
      app(async () => {
        throw new IsolationRuntimeMissingError("RuntimeClass gvisor has handler runc");
      }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual(new IsolationRuntimeMissingError("x").toResponseBody());
  });

  it("maps cluster errors to a generic 503", async () => {
    const res = await post(
      app(async () => {
        throw new Error("Kubernetes API create TokenReview: timed out");
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "sandbox_unavailable" });
  });

  it.each(["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"])(
    "is not reachable through the ingress (%s present)",
    async (header) => {
      const res = await post(
        app(async () => ASSIGNED),
        { [header]: "203.0.113.7" },
      );
      expect(res.status).toBe(404);
    },
  );

  it("is not served by the user-facing app (sandboxes get their own listener)", async () => {
    const res = await createApp().request("/v1/sandbox/session", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("rate-limits each source before any TokenReview (429 + Retry-After)", async () => {
    let calls = 0;
    let source = "10.42.0.7";
    const limited = createSandboxApp({
      provider: {
        identifyBootstrapToken: async () => {
          calls++;
          return ASSIGNED;
        },
      },
      sessionKeys: KEYS,
      limiter: createRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => 0 }),
      sourceOf: () => source,
    });
    expect((await post(limited)).status).toBe(200);
    expect((await post(limited)).status).toBe(200);
    const res = await post(limited);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await res.json()).toMatchObject({ code: "rate_limited" });
    expect(calls).toBe(2);
    source = "10.42.0.8";
    expect((await post(limited)).status).toBe(200);
  });
});

const UNASSIGNED: BootstrapIdentity = {
  state: "unassigned",
  namespace: "kobe-team-finance",
  podName: "w",
};

/** A server whose warm-pool pod is claimed after `claimAfterMs` of (fake) time. */
function waiting(claimAfterMs: number, opts: { maxWaitMs?: number; recheckMs?: number } = {}) {
  let clock = 0;
  const calls: number[] = [];
  const a = createSandboxApp({
    provider: {
      identifyBootstrapToken: async () => {
        calls.push(clock);
        return clock >= claimAfterMs ? ASSIGNED : UNASSIGNED;
      },
    },
    sessionKeys: KEYS,
    unassignedWait: { maxWaitMs: opts.maxWaitMs ?? 20_000, recheckMs: opts.recheckMs ?? 1_000 },
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { app: a, calls, clock: () => clock };
}

describe("POST /v1/sandbox/session long-poll while unassigned (KOBE-417)", () => {
  it("holds the request (Prefer: wait) and answers as soon as a recheck sees the claim", async () => {
    const w = waiting(4_500);
    const res = await post(w.app, { prefer: "wait=20" });
    expect(res.status).toBe(200);
    // Claimed at 4.5 s, answered at the next recheck: claim → grant ≤ one recheck (1 s).
    expect(w.clock()).toBe(5_000);
    expect(w.clock() - 4_500).toBeLessThanOrEqual(SESSION_WAIT.recheckMs);
    expect(w.calls).toEqual([0, 1_000, 2_000, 3_000, 4_000, 5_000]);
  });

  it("answers 409 with Preference-Applied once the wait runs out", async () => {
    const w = waiting(Infinity, { maxWaitMs: 5_000 });
    const res = await post(w.app, { prefer: "wait=20" });
    expect(res.status).toBe(409);
    expect(res.headers.get("preference-applied")).toBe("wait=5");
    expect(await res.json()).toMatchObject({ code: "sandbox_unassigned" });
    expect(w.clock()).toBe(5_000);
    expect(w.calls).toHaveLength(6);
  });

  it("caps the wait the client asks for at the server's maximum", async () => {
    const w = waiting(Infinity, { maxWaitMs: 3_000 });
    const res = await post(w.app, { prefer: "respond-async, wait=3600" });
    expect(res.headers.get("preference-applied")).toBe("wait=3");
    expect(w.clock()).toBe(3_000);
  });

  it("honours a shorter wait than the maximum", async () => {
    const w = waiting(Infinity);
    const res = await post(w.app, { prefer: "wait=2" });
    expect(res.headers.get("preference-applied")).toBe("wait=2");
    expect(w.clock()).toBe(2_000);
  });

  it("answers at once without Prefer: wait (older agents)", async () => {
    const w = waiting(Infinity);
    const res = await post(w.app, { prefer: "wait=nope" });
    expect(res.status).toBe(409);
    expect(res.headers.get("preference-applied")).toBeNull();
    expect(w.calls).toEqual([0]);
  });

  it("stops waiting and refuses when the pod goes away mid-wait", async () => {
    let n = 0;
    const a = createSandboxApp({
      provider: {
        identifyBootstrapToken: async () => {
          if (n++ < 2) return UNASSIGNED;
          throw new SandboxAuthError("pod gone");
        },
      },
      sessionKeys: KEYS,
      sleep: async () => {},
    });
    const res = await post(a, { prefer: "wait=20" });
    expect(res.status).toBe(401);
    expect(n).toBe(3);
  });

  it("stops rechecking once the client has gone", async () => {
    const controller = new AbortController();
    let n = 0;
    const a = createSandboxApp({
      provider: {
        identifyBootstrapToken: async () => {
          if (++n === 2) controller.abort();
          return UNASSIGNED;
        },
      },
      sessionKeys: KEYS,
      sleep: async () => {},
    });
    await a.request("/v1/sandbox/session", {
      method: "POST",
      headers: { authorization: "Bearer bootstrap.token.value", prefer: "wait=20" },
      signal: controller.signal,
    });
    expect(n).toBe(2);
  });
});

describe("POST /v1/sandbox/session tracing (KOBE-417)", () => {
  let telemetry: Telemetry | undefined;
  afterEach(async () => {
    await telemetry?.shutdown();
    telemetry = undefined;
  });
  const traced = () => {
    const exporter = new InMemorySpanExporter();
    telemetry = initTelemetry(
      {
        enabled: true,
        endpoint: "http://x:4318",
        headers: {},
        captureContent: false,
        serviceName: "t",
      },
      { exporter },
    );
    return exporter;
  };

  it("leaves routine sandbox_unassigned answers untraced", async () => {
    const exporter = traced();
    expect((await post(app(async () => UNASSIGNED))).status).toBe(409);
    expect(
      (await post(waiting(Infinity, { maxWaitMs: 2_000 }).app, { prefer: "wait=2" })).status,
    ).toBe(409);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("still traces grants and refusals", async () => {
    const exporter = traced();
    await post(app(async () => ASSIGNED));
    await post(
      app(async () => {
        throw new SandboxAuthError("x");
      }),
    );
    await post(
      app(async () => {
        throw new Error("boom");
      }),
    );
    expect(
      exporter.getFinishedSpans().map((s) => s.attributes["http.response.status_code"]),
    ).toEqual([200, 401, 503]);
  });
});
