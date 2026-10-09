import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { UpstreamPolicy } from "./config.js";
import { probeRoutes } from "./probe.js";
import { FakeUpstream } from "./testing/fake-upstream.js";
import { createUpstreamClient, type UpstreamClient } from "./upstream.js";

const KEY = "k".repeat(40);
const fake = new FakeUpstream();
let upstream: UpstreamClient;

beforeAll(async () => {
  await fake.start();
  const policy: UpstreamPolicy = {
    allowInsecureHttp: true,
    allowedPorts: [Number(new URL(fake.url).port)],
    allowedInternalCidrs: ["127.0.0.0/8"],
    deniedCidrs: [],
  };
  upstream = createUpstreamClient({ policy, maxResponseBytes: 64 * 1024 });
});
afterAll(async () => {
  await upstream.close();
  await fake.stop();
});
beforeEach(() => {
  fake.options = {};
  fake.received.length = 0;
});

const probe = () =>
  probeRoutes({ internalKey: KEY, upstream, timeoutMs: 5_000, maxRequestBytes: 4096 });
const post = (body: unknown, auth: string | undefined = `Bearer ${KEY}`) =>
  probe().request("/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /internal/v1/probe", () => {
  it("returns the live tools/list for the server", async () => {
    const tools = [{ name: "a", description: "d", inputSchema: { type: "object" } }];
    fake.options = { tools };
    const res = await post({ url: fake.url });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tools });
  });

  it("reports an upstream failure as data", async () => {
    fake.options = { status: 401 };
    expect(await (await post({ url: fake.url })).json()).toEqual({
      ok: false,
      failure: "auth_required",
    });
  });

  it("answers 401 without the internal key, and a sandbox token is not a key", async () => {
    expect((await post({ url: fake.url }, "")).status).toBe(401);
    expect((await post({ url: fake.url }, "Bearer wrong")).status).toBe(401);
    expect(fake.received).toHaveLength(0);
  });

  it("rejects unknown fields and bad bodies", async () => {
    expect((await post({ url: fake.url, headers: { authorization: "x" } })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it("is mounted only when probe deps are given", async () => {
    const without = createApp();
    expect((await without.request("/internal/v1/probe", { method: "POST" })).status).toBe(404);
  });
});
