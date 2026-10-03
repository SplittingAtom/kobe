import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UpstreamPolicy } from "./config.js";
import { FakeUpstream } from "./testing/fake-upstream.js";
import { createUpstreamClient, type UpstreamClient } from "./upstream.js";

const LOOPBACK_ALLOWED: UpstreamPolicy = {
  allowInsecureHttp: true,
  allowedPorts: [],
  allowedInternalCidrs: ["127.0.0.0/8"],
  deniedCidrs: [],
};

const fake = new FakeUpstream();
let client: UpstreamClient;
let policy: UpstreamPolicy;

beforeAll(async () => {
  await fake.start();
  policy = { ...LOOPBACK_ALLOWED, allowedPorts: [Number(new URL(fake.url).port)] };
  client = createUpstreamClient({ policy, maxResponseBytes: 64 * 1024 });
});
afterAll(async () => {
  await client.close();
  await fake.stop();
});
beforeEach(() => {
  fake.received.length = 0;
  fake.deletes.length = 0;
  fake.options = {};
});

const call = (overrides: Partial<Parameters<UpstreamClient["callTool"]>[0]> = {}) =>
  client.callTool({
    url: fake.url,
    headers: {},
    tool: "get_issue",
    arguments: { id: 7 },
    signal: AbortSignal.timeout(5_000),
    ...overrides,
  });

describe("upstream MCP client (Streamable HTTP)", () => {
  it("initializes, sends initialized, calls the tool with exactly the arguments", async () => {
    expect(await call()).toEqual({
      ok: true,
      result: { content: [{ type: "text", text: 'get_issue:{"id":7}' }] },
    });
    expect(fake.received.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    const [init, , toolCall] = fake.received;
    expect(init?.message.params).toMatchObject({
      protocolVersion: "2025-11-25",
      clientInfo: { name: "kobe-mcp-proxy" },
    });
    expect(init?.headers.accept).toBe("application/json, text/event-stream");
    expect(toolCall?.headers["mcp-protocol-version"]).toBe("2025-11-25");
    expect(toolCall?.message.params).toEqual({ name: "get_issue", arguments: { id: 7 } });
  });

  it("reads SSE answers, skipping server notifications", async () => {
    fake.options = { sse: true };
    expect(await call()).toMatchObject({ ok: true, result: { content: [{ type: "text" }] } });
  });

  it("keeps the session id and ends the session afterwards", async () => {
    fake.options = { session: true };
    expect((await call()).ok).toBe(true);
    expect(fake.received.slice(1).every((r) => r.headers["mcp-session-id"] === "sess-1")).toBe(
      true,
    );
    await expect.poll(() => fake.deletes).toEqual(["sess-1"]);
  });

  it("sends credential headers given to it (and only those)", async () => {
    await call({ headers: { authorization: "Bearer upstream-token" } });
    expect(fake.received.every((r) => r.headers.authorization === "Bearer upstream-token")).toBe(
      true,
    );
  });

  it("passes a JSON-RPC error of tools/call through", async () => {
    fake.options = { rpcError: true };
    expect(await call()).toEqual({
      ok: false,
      failure: "rpc_error",
      code: -32010,
      message: "upstream says no",
    });
  });

  it("refuses answers over the size cap", async () => {
    fake.options = { padding: 100 * 1024 };
    expect(await call()).toEqual({ ok: false, failure: "too_large" });
    fake.options = { padding: 100 * 1024, sse: true };
    expect(await call()).toEqual({ ok: false, failure: "too_large" });
  });

  it("gives up at the deadline", async () => {
    fake.options = { delayMs: 2_000 };
    expect(await call({ signal: AbortSignal.timeout(200) })).toEqual({
      ok: false,
      failure: "timeout",
    });
  });

  it("reports refused credentials as auth_required and other statuses as http_error", async () => {
    fake.options = { status: 401 };
    expect(await call()).toEqual({ ok: false, failure: "auth_required" });
    fake.options = { status: 500 };
    expect(await call()).toEqual({ ok: false, failure: "http_error" });
  });

  it("refuses a server that negotiates an unknown protocol version", async () => {
    fake.options = { protocolVersion: "1999-01-01" };
    expect(await call()).toEqual({ ok: false, failure: "protocol_error" });
    expect(fake.calls()).toEqual([]);
  });

  it("never follows redirects", async () => {
    fake.options = { redirectTo: "http://169.254.169.254/latest/meta-data" };
    expect((await call()).ok).toBe(false);
    expect(fake.received).toHaveLength(1);
  });
});

describe("where the client may connect", () => {
  it("refuses plain http unless allowed, other ports, and credentials in the URL", async () => {
    const strict = createUpstreamClient({
      policy: { ...policy, allowInsecureHttp: false },
      maxResponseBytes: 1024,
    });
    expect(await strict.callTool({ ...base(), url: fake.url })).toEqual({
      ok: false,
      failure: "url_not_allowed",
    });
    await strict.close();
    expect(await call({ url: fake.url.replace(/:\d+\//, ":1/") })).toEqual({
      ok: false,
      failure: "url_not_allowed",
    });
    expect(await call({ url: fake.url.replace("http://", "http://u:p@") })).toEqual({
      ok: false,
      failure: "url_not_allowed",
    });
    expect(fake.received).toEqual([]);
  });

  it("refuses internal addresses unless an operator allowed them (literal and resolved)", async () => {
    const closed = createUpstreamClient({
      policy: { ...policy, allowedInternalCidrs: [] },
      maxResponseBytes: 1024,
      resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    });
    expect(await closed.callTool({ ...base(), url: fake.url })).toEqual({
      ok: false,
      failure: "url_not_allowed",
    });
    const named = fake.url.replace("127.0.0.1", "mcp.example.test");
    expect(await closed.callTool({ ...base(), url: named })).toEqual({
      ok: false,
      failure: "forbidden_address",
    });
    await closed.close();
    expect(fake.received).toEqual([]);
  });

  it("refuses a name when any of its addresses is internal (rebinding)", async () => {
    const mixed = createUpstreamClient({
      policy: { ...policy, allowedInternalCidrs: [] },
      maxResponseBytes: 1024,
      resolve: () =>
        Promise.resolve([
          { address: "93.184.215.14", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ]),
    });
    expect(
      await mixed.callTool({ ...base(), url: fake.url.replace("127.0.0.1", "mixed.example.test") }),
    ).toEqual({ ok: false, failure: "forbidden_address" });
    await mixed.close();
  });

  it("connects to the checked address of an allowed name", async () => {
    const resolving = createUpstreamClient({
      policy,
      maxResponseBytes: 64 * 1024,
      resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    });
    const res = await resolving.callTool({
      ...base(),
      url: fake.url.replace("127.0.0.1", "mcp.example.test"),
    });
    expect(res.ok).toBe(true);
    await resolving.close();
  });
});

function base() {
  return {
    headers: {},
    tool: "get_issue",
    arguments: {},
    signal: AbortSignal.timeout(5_000),
  };
}
