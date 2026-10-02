import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createRateLimiter } from "../sandbox/rate-limit.js";
import { IsolationRuntimeMissingError } from "../isolation/gate.js";
import type { BootstrapIdentity } from "../sandbox/provider.js";
import { SandboxAuthError } from "../sandbox/provider.js";
import { verifySessionToken } from "../sandbox/session-token.js";
import { createSandboxApp } from "./sandbox.js";
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
