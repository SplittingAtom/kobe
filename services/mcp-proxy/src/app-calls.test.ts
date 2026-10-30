import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@kobe/telemetry";
import { isChildOf, spanNamed, traced } from "./testing/traced.js";
import { createApp } from "./app.js";
import { appCallRoutes } from "./app-calls.js";
import { FakeUpstream } from "./testing/fake-upstream.js";
import { createUpstreamClient, type UpstreamClient } from "./upstream.js";

const KEY = "k".repeat(40);
const CONNECTOR = "11111111-1111-4111-8111-111111111111";
const fake = new FakeUpstream();
let upstream: UpstreamClient;

beforeAll(async () => {
  await fake.start();
  upstream = createUpstreamClient({
    policy: {
      allowInsecureHttp: true,
      allowedPorts: [Number(new URL(fake.url).port)],
      allowedInternalCidrs: ["127.0.0.1/32"],
      deniedCidrs: [],
    },
    maxResponseBytes: 64 * 1024,
  });
});
afterAll(async () => {
  await upstream.close();
  await fake.stop();
});
beforeEach(() => {
  fake.options = {};
  fake.received.length = 0;
});

const routes = () => appCallRoutes({ internalKey: KEY, upstream, timeoutMs: 5_000 });
const post = (body: unknown, auth = `Bearer ${KEY}`) =>
  routes().request("/", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
const call = (extra: Record<string, unknown> = {}) => ({
  connector_id: CONNECTOR,
  url: fake.url,
  tool: "preview_table",
  arguments: { table: "t" },
  ...extra,
});

describe("POST /internal/v1/app-calls (KOBE-436)", () => {
  it("calls the upstream tool with the member's key and returns the result, never the key", async () => {
    const res = await post(call({ api_key: "sk-member-0123456789" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, result: { content: [{ type: "text" }] } });
    expect(JSON.stringify(body)).not.toContain("sk-member");
    expect(fake.calls()[0]?.headers.authorization).toBe("Bearer sk-member-0123456789");
    expect(fake.calls()[0]?.message.params).toEqual({
      name: "preview_table",
      arguments: { table: "t" },
    });
  });

  it("sends an OAuth access token as a bearer, and nothing for a none connector", async () => {
    await post(call({ access_token: "at-0123" }));
    expect(fake.calls().at(-1)?.headers.authorization).toBe("Bearer at-0123");
    await post(call());
    expect(fake.calls().at(-1)?.headers.authorization).toBeUndefined();
  });

  it("reports upstream failures as data", async () => {
    fake.options = { rpcError: true };
    expect(await (await post(call())).json()).toMatchObject({
      ok: false,
      failure: "rpc_error",
      code: -32010,
    });
    fake.options = { status: 401 };
    expect(await (await post(call())).json()).toEqual({ ok: false, failure: "auth_required" });
  });

  it("refuses without the internal key, bad bodies, both credentials and big bodies", async () => {
    expect((await post(call(), "Bearer sandbox-token")).status).toBe(401);
    expect((await post({ ...call(), extra: 1 })).status).toBe(400);
    expect((await post(call({ tool: "has space" }))).status).toBe(400);
    expect((await post(call({ api_key: "a", access_token: "b" }))).status).toBe(400);
    expect((await post(call({ arguments: { x: "y".repeat(100 * 1024) } }))).status).toBe(413);
    expect(fake.received).toHaveLength(0);
  });

  it("is mounted only when its deps are given", async () => {
    const res = await createApp().request("/internal/v1/app-calls", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("upstream span (KOBE-527)", () => {
  const postTraced = (body: unknown) =>
    createApp(undefined, undefined, { internalKey: KEY, upstream, timeoutMs: 5_000 }).request(
      "/internal/v1/app-calls",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
      },
    );

  it("records the app backend's round trip as a child of the route span, kind app", async () => {
    await traced(async (exporter) => {
      expect((await postTraced(call({ api_key: "sk-member-0123456789" }))).status).toBe(200);
      const route = spanNamed(exporter, "POST /internal/v1/app-calls");
      const span = spanNamed(exporter, "mcp.upstream");
      expect(isChildOf(span, route)).toBe(true);
      expect(span?.attributes).toMatchObject({
        "kobe.upstream.kind": "app",
        "kobe.upstream.method": "tools/call",
        "kobe.upstream.outcome": "ok",
        "kobe.upstream.error": false,
      });
      const text = JSON.stringify(span?.attributes);
      expect(text).not.toContain(CONNECTOR);
      expect(text).not.toContain("preview_table");
      expect(text).not.toContain("sk-member");
    });
  });

  it("flags an upstream JSON-RPC error", async () => {
    fake.options = { rpcError: true };
    await traced(async (exporter) => {
      await postTraced(call());
      const span = spanNamed(exporter, "mcp.upstream");
      expect(span?.attributes["kobe.upstream.outcome"]).toBe("rpc_error");
      expect(span?.attributes["kobe.upstream.error"]).toBe(true);
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    });
  });
});
