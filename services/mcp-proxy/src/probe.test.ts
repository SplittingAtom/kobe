import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode } from "@kobe/telemetry";
import { isChildOf, spanNamed, traced } from "./testing/traced.js";
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

  it("lists with the user's API key as a bearer token when the server sends one (KOBE-108)", async () => {
    fake.options = { tools: [] };
    await post({ url: fake.url, api_key: "sk-live-0123456789" });
    expect(fake.received.at(-1)?.headers.authorization).toBe("Bearer sk-live-0123456789");
    fake.received.length = 0;
    await post({ url: fake.url });
    expect(fake.received.at(-1)?.headers.authorization).toBeUndefined();
  });

  it("refuses an api_key that is not a plain header value", async () => {
    expect((await post({ url: fake.url, api_key: "has space" })).status).toBe(400);
    expect(fake.received).toHaveLength(0);
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

  it("adds the ui:// templates the tools name when asked (KOBE-433)", async () => {
    const tools = [{ name: "open", inputSchema: {}, _meta: { ui: { resourceUri: "ui://c/app" } } }];
    fake.options = {
      tools,
      resources: [{ uri: "ui://c/app", mimeType: "text/html;profile=mcp-app", text: "<p/>" }],
    };
    expect(await (await post({ url: fake.url, ui_resources: true })).json()).toEqual({
      ok: true,
      tools,
      ui_resources: [
        { uri: "ui://c/app", mimeType: "text/html;profile=mcp-app", text: "<p/>", meta: {} },
      ],
    });
    fake.received.length = 0;
    expect(await (await post({ url: fake.url })).json()).toEqual({ ok: true, tools });
    expect(fake.received.map((r) => r.method)).not.toContain("resources/read");
    expect((await post({ url: fake.url, ui_resources: ["ui://c/app"] })).status).toBe(400);
    // A failing resources/list skips only the template part (review MEDIUM-3).
    fake.options = { ...fake.options, listErrorCode: -32603 };
    expect(await (await post({ url: fake.url, ui_resources: true })).json()).toEqual({
      ok: true,
      tools,
      ui_resources_skipped: "rpc_error",
    });
  });

  it("is mounted only when probe deps are given", async () => {
    const without = createApp();
    expect((await without.request("/internal/v1/probe", { method: "POST" })).status).toBe(404);
  });
});

describe("upstream span (KOBE-528)", () => {
  const traceApp = () =>
    createApp(undefined, { internalKey: KEY, upstream, timeoutMs: 5_000, maxRequestBytes: 4096 });
  const postTraced = (body: unknown) =>
    traceApp().request("/internal/v1/probe", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });

  it("records the upstream round trip as a child of the route span, without the connector's URL", async () => {
    fake.options = { tools: [{ name: "a", inputSchema: { type: "object" } }] };
    await traced(async (exporter) => {
      expect((await postTraced({ url: fake.url })).status).toBe(200);
      const route = spanNamed(exporter, "POST /internal/v1/probe");
      const span = spanNamed(exporter, "mcp.upstream");
      expect(isChildOf(span, route)).toBe(true);
      expect(span?.kind).toBe(SpanKind.CLIENT);
      expect(span?.attributes).toEqual({
        "kobe.upstream.kind": "probe",
        "kobe.upstream.method": "tools/list",
        "kobe.upstream.outcome": "ok",
        "kobe.upstream.error": false,
        // initialize, notifications/initialized, tools/list
        "kobe.upstream.requests": 3,
      });
      expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
      expect(JSON.stringify(span?.attributes)).not.toContain("127.0.0.1");
    });
  });

  it("flags a failed probe as an error with its failure kind", async () => {
    fake.options = { status: 401 };
    await traced(async (exporter) => {
      await postTraced({ url: fake.url });
      const span = spanNamed(exporter, "mcp.upstream");
      expect(span?.attributes["kobe.upstream.outcome"]).toBe("auth_required");
      expect(span?.attributes["kobe.upstream.error"]).toBe(true);
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    });
  });
});
