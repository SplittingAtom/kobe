import { createHash, randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@kobe/protocol";
import { signSessionToken } from "@kobe/session-token";
import { createApp } from "./app.js";
import { DEFAULT_LIMITS, type Limits } from "./config.js";
import {
  NO_GRANTS,
  createServerCredentials,
  type CredentialResolver,
  type GrantAnswer,
} from "./credentials.js";
import { createLimiter } from "./limits.js";
import type {
  CallDecision,
  CallQuery,
  PolicyServer,
  ServerAnswer,
  ToolsResponse,
} from "./server-client.js";
import { FakeUpstream } from "./testing/fake-upstream.js";
import { createUpstreamClient, type UpstreamClient } from "./upstream.js";

const KEY = "k".repeat(48);
const TEAM = randomUUID();
const USER = randomUUID();
const SANDBOX = randomUUID();
const CONNECTOR = randomUUID();
const THREAD = randomUUID();

function token(
  options: {
    key?: string;
    aud?: "kobe.mcp-proxy" | "kobe.egress-proxy";
    ttl?: number;
    sub?: string;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: options.aud ?? "kobe.mcp-proxy",
      sub: options.sub ?? SANDBOX,
      team_id: TEAM,
      user_id: USER,
      iat: now,
      exp: now + (options.ttl ?? 600),
      jti: `t-${randomUUID()}`,
    },
    options.key ?? KEY,
  );
}

const sha = (args: unknown) => createHash("sha256").update(canonicalJson(args)).digest("hex");

/** The server stand-in: answers from `next`, records what the proxy asked. */
class FakePolicyServer implements PolicyServer {
  readonly asked: { token: string; query: CallQuery }[] = [];
  tools: ServerAnswer<ToolsResponse> = {
    ok: true,
    value: {
      connector: { id: CONNECTOR, name: "jira" },
      tools: [
        {
          name: "get_issue",
          pi_name: "mcp__jira__get_issue",
          description: "Get an issue (pinned)",
          input_schema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        {
          name: "create_issue",
          pi_name: "mcp__jira__create_issue",
          title: "Create",
          description: "Create an issue (pinned)",
          input_schema: { type: "object" },
          output_schema: { type: "object" },
          annotations: {},
        },
      ],
    },
  };
  /** Decision per call; default: allow exactly what was asked. */
  next: ((query: CallQuery) => ServerAnswer<CallDecision>) | undefined;
  upstreamUrl = "";

  listTools() {
    return Promise.resolve(this.tools);
  }

  fetchGrant() {
    return Promise.resolve<GrantAnswer>({ ok: false, failure: "not_connected" });
  }

  decide(t: string, query: CallQuery) {
    this.asked.push({ token: t, query });
    if (this.next) return Promise.resolve(this.next(query));
    return Promise.resolve<ServerAnswer<CallDecision>>({
      ok: true,
      value: {
        decision: "allow",
        connector: {
          id: query.connectorId,
          name: "jira",
          url: this.upstreamUrl,
          auth_kind: "none",
        },
        tool: { name: query.tool, pi_name: `mcp__jira__${query.tool}` },
        input_sha256: sha(query.arguments),
        reason: "risk_read",
      },
    });
  }
}

const fake = new FakeUpstream();
let server: FakePolicyServer;
let upstream: UpstreamClient;
let credentials: CredentialResolver;
let limits: Limits;

function app(overrides: { limits?: Partial<Limits> } = {}) {
  const l = { ...limits, ...overrides.limits };
  return createApp({
    sessionKey: KEY,
    server,
    upstream,
    credentials,
    limiter: createLimiter({
      burst: l.requestBurst,
      perSecond: l.requestsPerSecond,
      callsPerSandbox: l.callsPerSandbox,
      maxConcurrentCalls: l.maxConcurrentCalls,
    }),
    limits: l,
    log: pino({ level: "silent" }),
  });
}

beforeAll(async () => {
  await fake.start();
  upstream = createUpstreamClient({
    policy: {
      allowInsecureHttp: true,
      allowedPorts: [Number(new URL(fake.url).port)],
      allowedInternalCidrs: ["127.0.0.0/8"],
      deniedCidrs: [],
    },
    maxResponseBytes: 1024 * 1024,
  });
});
afterAll(async () => {
  await upstream.close();
  await fake.stop();
});
beforeEach(() => {
  server = new FakePolicyServer();
  server.upstreamUrl = fake.url;
  credentials = NO_GRANTS;
  limits = { ...DEFAULT_LIMITS, upstreamTimeoutMs: 5_000 };
  fake.received.length = 0;
  fake.options = {};
});

let nextId = 1;
async function rpc(
  method: string,
  params?: unknown,
  options: {
    token?: string;
    app?: ReturnType<typeof app>;
    headers?: Record<string, string>;
    body?: string;
    connector?: string;
  } = {},
) {
  const res = await (options.app ?? app()).request(`/v1/mcp/${options.connector ?? CONNECTOR}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token ?? token()}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "kobe-thread-id": THREAD,
      ...options.headers,
    },
    body:
      options.body ??
      JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        ...(params === undefined ? {} : { params }),
      }),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    json: text ? (JSON.parse(text) as Record<string, any>) : undefined,
  };
}

describe("authentication and transport", () => {
  it("refuses a missing, forged, expired or other-audience token (401) before asking anyone", async () => {
    for (const t of [
      "",
      "forged.token.value",
      token({ key: "x".repeat(48) }),
      token({ ttl: -60 }),
      token({ aud: "kobe.egress-proxy" }),
    ]) {
      const res = await rpc("tools/list", undefined, { token: t });
      expect(res.status, t).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    expect(server.asked).toEqual([]);
  });

  it("answers only POST (stateless: no GET stream, no session to delete)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await app().request(`/v1/mcp/${CONNECTOR}`, {
        method,
        headers: { authorization: `Bearer ${token()}` },
      });
      expect(res.status, method).toBe(405);
    }
  });

  it("refuses non-JSON bodies, batches, oversized bodies and unknown protocol versions", async () => {
    expect(
      (await rpc("ping", undefined, { headers: { "content-type": "text/plain" } })).status,
    ).toBe(415);
    const batch = await rpc("ping", undefined, { body: "[]" });
    expect(batch.status).toBe(400);
    expect(batch.json?.error.code).toBe(-32600);
    const dup = await rpc("ping", undefined, {
      body: '{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}',
    });
    expect(dup.json?.error.code).toBe(-32700);
    const big = await rpc("ping", undefined, {
      app: app({ limits: { maxRequestBytes: 2_048 } }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: { pad: "x".repeat(4_096) },
      }),
    });
    expect(big.status).toBe(413);
    expect(
      (await rpc("ping", undefined, { headers: { "mcp-protocol-version": "1999-01-01" } })).status,
    ).toBe(400);
  });

  it("accepts notifications and client responses with 202", async () => {
    const res = await rpc("", undefined, {
      body: '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    });
    expect(res.status).toBe(202);
  });

  it("answers 404 for a connector id that is not a uuid", async () => {
    expect((await rpc("tools/list", undefined, { connector: "jira" })).status).toBe(404);
  });

  it("rate-limits each sandbox", async () => {
    const limited = app({ limits: { requestBurst: 2, requestsPerSecond: 1 } });
    expect((await rpc("ping", undefined, { app: limited })).status).toBe(200);
    expect((await rpc("ping", undefined, { app: limited })).status).toBe(200);
    const third = await rpc("ping", undefined, { app: limited });
    expect(third.status).toBe(429);
    // Another sandbox has its own bucket.
    expect(
      (await rpc("ping", undefined, { app: limited, token: token({ sub: randomUUID() }) })).status,
    ).toBe(200);
  });
});

describe("initialize, ping, tools/list", () => {
  it("negotiates the client's version when supported, else the newest", async () => {
    const res = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {},
    });
    expect(res.json?.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "kobe-mcp-proxy", version: "1.0.0" },
    });
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const newest = await rpc("initialize", { protocolVersion: "2099-01-01" });
    expect(newest.json?.result.protocolVersion).toBe("2025-11-25");
  });

  it("refuses to initialize a connector the team has not enabled (403)", async () => {
    server.tools = { ok: false, failure: "not_available" };
    expect((await rpc("initialize", {})).status).toBe(403);
    server.tools = { ok: false, failure: "sandbox_unauthorized" };
    expect((await rpc("initialize", {})).status).toBe(401);
    server.tools = { ok: false, failure: "unavailable" };
    expect((await rpc("initialize", {})).status).toBe(503);
  });

  it("answers ping", async () => {
    expect((await rpc("ping")).json?.result).toEqual({});
  });

  it("lists the pinned tools the server exposes, in MCP shape", async () => {
    const res = await rpc("tools/list");
    expect(res.json?.result).toEqual({
      tools: [
        {
          name: "get_issue",
          description: "Get an issue (pinned)",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        {
          name: "create_issue",
          title: "Create",
          description: "Create an issue (pinned)",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      ],
    });
    expect(fake.received).toEqual([]);
  });

  it("does not offer resources or prompts in v1 (D27 later)", async () => {
    for (const method of [
      "resources/list",
      "resources/read",
      "prompts/list",
      "sampling/createMessage",
    ]) {
      expect((await rpc(method)).json?.error.code, method).toBe(-32601);
    }
  });
});

describe("tools/call", () => {
  it("asks the server first, then forwards exactly the decided (canonical) input", async () => {
    const res = await rpc("tools/call", {
      name: "get_issue",
      arguments: { b: [2, 1], a: "x" },
      _meta: { "kobe.dev/tool_call_id": "toolu_9" },
    });
    expect(res.json?.result).toEqual({
      content: [{ type: "text", text: 'get_issue:{"a":"x","b":[2,1]}' }],
    });
    expect(server.asked).toEqual([
      {
        token: expect.any(String),
        query: {
          connectorId: CONNECTOR,
          tool: "get_issue",
          arguments: { a: "x", b: [2, 1] },
          threadId: THREAD,
          toolCallId: "toolu_9",
        },
      },
    ]);
    expect(fake.calls().map((c) => c.message.params)).toEqual([
      { name: "get_issue", arguments: { a: "x", b: [2, 1] } },
    ]);
  });

  it("runs nothing upstream when the server denies (tampered kobe-policy, no approval)", async () => {
    server.next = () => ({
      ok: true,
      value: {
        decision: "deny",
        code: "risk_write",
        message: "This call needs your approval.",
        approval_failure: "no_approval",
      },
    });
    const res = await rpc("tools/call", { name: "create_issue", arguments: { title: "x" } });
    expect(res.json?.result).toEqual({
      content: [{ type: "text", text: "Kobe denied this call: This call needs your approval." }],
      isError: true,
    });
    expect(fake.received).toEqual([]);
  });

  it("runs nothing upstream for a tool disabled by drift until re-approved (KOBE-102)", async () => {
    server.next = () => ({
      ok: true,
      value: {
        decision: "deny",
        code: "tool_drifted",
        message: "This tool changed since it was approved and is disabled until re-approved.",
      },
    });
    const res = await rpc("tools/call", { name: "get_issue", arguments: { a: "x" } });
    expect(res.json?.result.isError).toBe(true);
    expect(res.json?.result.content[0].text).toContain("disabled until re-approved");
    expect(fake.received).toEqual([]);
  });

  it.each([
    ["connector_not_enabled", "This connector is not enabled in your team."],
    ["connector_exposure", "create_issue is not exposed to agents in your team (read-only)."],
  ] as const)(
    "runs nothing upstream and says why when the team's exposure refuses (%s, KOBE-106)",
    async (code, message) => {
      server.next = () => ({ ok: true, value: { decision: "deny", code, message } });
      const res = await rpc("tools/call", { name: "create_issue", arguments: { a: "x" } });
      expect(res.json?.result.isError).toBe(true);
      expect(res.json?.result.content[0].text).toContain(message);
      expect(fake.received).toEqual([]);
    },
  );

  it("runs nothing upstream when the server cannot be reached (fail closed)", async () => {
    server.next = () => ({ ok: false, failure: "unavailable" });
    const res = await rpc("tools/call", { name: "create_issue", arguments: {} });
    expect(res.json?.result.isError).toBe(true);
    expect(fake.received).toEqual([]);
  });

  it("refuses an allow that is not for exactly this call (other tool, connector or input)", async () => {
    for (const tamper of [
      (d: any) => ({ ...d, tool: { ...d.tool, name: "delete_issue" } }),
      (d: any) => ({ ...d, connector: { ...d.connector, id: randomUUID() } }),
      (d: any) => ({ ...d, input_sha256: sha({ other: true }) }),
    ]) {
      server.next = (q) => {
        const allow = {
          decision: "allow" as const,
          connector: { id: q.connectorId, name: "jira", url: fake.url, auth_kind: "none" as const },
          tool: { name: q.tool, pi_name: "mcp__jira__x" },
          input_sha256: sha(q.arguments),
          reason: "approval_granted",
        };
        return { ok: true, value: tamper(allow) };
      };
      const res = await rpc("tools/call", { name: "create_issue", arguments: { title: "x" } });
      expect(res.json?.result.isError).toBe(true);
    }
    expect(fake.received).toEqual([]);
  });

  it("says not connected for a connector that needs a credential the user has not granted", async () => {
    server.next = (q) => ({
      ok: true,
      value: {
        decision: "allow",
        connector: { id: q.connectorId, name: "jira", url: fake.url, auth_kind: "oauth" },
        tool: { name: q.tool, pi_name: "mcp__jira__get_issue" },
        input_sha256: sha(q.arguments),
        reason: "risk_read",
      },
    });
    const res = await rpc("tools/call", { name: "get_issue", arguments: {} });
    expect(res.json?.result.content[0].text).toMatch(/Connect your account for jira/);
    expect(res.json?.result.content[0].text).not.toMatch(/approval/);
    expect(fake.received).toEqual([]);
  });

  it("says when an approval was spent on a call that could not run (review L3)", async () => {
    server.next = (q) => ({
      ok: true,
      value: {
        decision: "allow",
        connector: { id: q.connectorId, name: "jira", url: fake.url, auth_kind: "api_key" },
        tool: { name: q.tool, pi_name: "mcp__jira__create_issue" },
        input_sha256: sha(q.arguments),
        reason: "approval_granted",
        approval_id: randomUUID(),
      },
    });
    const res = await rpc("tools/call", { name: "create_issue", arguments: {} });
    expect(res.json?.result.isError).toBe(true);
    expect(res.json?.result.content[0].text).toMatch(/approval for it has been used/);
    expect(fake.received).toEqual([]);
  });

  it("attaches the resolved credential upstream, never anything from the sandbox", async () => {
    credentials = {
      headersFor: () => Promise.resolve({ ok: true, headers: { authorization: "Bearer grant" } }),
    };
    await rpc(
      "tools/call",
      { name: "get_issue", arguments: {} },
      { headers: { "x-api-key": "from-sandbox" } },
    );
    const [first] = fake.received;
    expect(first?.headers.authorization).toBe("Bearer grant");
    expect(first?.headers["x-api-key"]).toBeUndefined();
    expect(fake.received.every((r) => r.headers["kobe-thread-id"] === undefined)).toBe(true);
  });

  it("uses the server's per-user API key upstream and never shows it to the sandbox (KOBE-108)", async () => {
    const apiKey = "sk-live-secret-0123456789";
    server.fetchGrant = () => Promise.resolve({ ok: true, value: { kind: "api_key", apiKey } });
    credentials = createServerCredentials(server);
    server.next = (q) => ({
      ok: true,
      value: {
        decision: "allow",
        connector: { id: q.connectorId, name: "jira", url: fake.url, auth_kind: "api_key" },
        tool: { name: q.tool, pi_name: "mcp__jira__get_issue" },
        input_sha256: sha(q.arguments),
        reason: "risk_read",
      },
    });
    const res = await app().request(`/v1/mcp/${CONNECTOR}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token()}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "kobe-thread-id": THREAD,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_issue", arguments: { id: 1 } },
      }),
    });
    const text = await res.text();
    expect(fake.received.at(-1)?.headers.authorization).toBe(`Bearer ${apiKey}`);
    // Nothing the sandbox receives (body or headers) carries the key.
    expect(text).not.toContain(apiKey);
    expect([...res.headers.values()].join("\n")).not.toContain(apiKey);
    // The server was asked with the sandbox's own token, so it can only answer for that user.
    expect(JSON.stringify(server.asked)).not.toContain(apiKey);
  });

  it("says not connected when the user has no API key, and runs nothing upstream", async () => {
    credentials = createServerCredentials(server);
    server.next = (q) => ({
      ok: true,
      value: {
        decision: "allow",
        connector: { id: q.connectorId, name: "jira", url: fake.url, auth_kind: "api_key" },
        tool: { name: q.tool, pi_name: "mcp__jira__get_issue" },
        input_sha256: sha(q.arguments),
        reason: "risk_read",
      },
    });
    const res = await rpc("tools/call", { name: "get_issue", arguments: {} });
    expect(res.json?.result.content[0].text).toMatch(/Connect your account for jira/);
    expect(fake.received).toEqual([]);
  });

  it("does not pass the sandbox's session token upstream", async () => {
    const t = token();
    await rpc("tools/call", { name: "get_issue", arguments: {} }, { token: t });
    for (const r of fake.received) expect(JSON.stringify(r.headers)).not.toContain(t);
  });

  it("maps upstream failures to tool errors and passes JSON-RPC errors through", async () => {
    fake.options = { status: 500 };
    expect(
      (await rpc("tools/call", { name: "get_issue", arguments: {} })).json?.result.isError,
    ).toBe(true);
    fake.options = { rpcError: true };
    expect((await rpc("tools/call", { name: "get_issue", arguments: {} })).json?.error).toEqual({
      code: -32010,
      message: "upstream says no",
    });
  });

  it("validates params: a name, object arguments, safe JSON", async () => {
    expect((await rpc("tools/call", {})).json?.error.code).toBe(-32602);
    expect((await rpc("tools/call", { name: "get_issue", arguments: [1] })).json?.error.code).toBe(
      -32602,
    );
    expect(
      (await rpc("tools/call", { name: "get_issue", arguments: { n: 2 ** 60 } })).json?.error.code,
    ).toBe(-32602);
    expect(server.asked).toEqual([]);
  });

  it("omits the thread when the header is not a uuid (the server then denies)", async () => {
    await rpc(
      "tools/call",
      { name: "get_issue", arguments: {} },
      { headers: { "kobe-thread-id": "nope" } },
    );
    expect(server.asked[0]?.query.threadId).toBeUndefined();
  });

  it("caps concurrent calls per sandbox", async () => {
    fake.options = { delayMs: 300 };
    const limited = app({ limits: { callsPerSandbox: 1 } });
    const [a, b] = await Promise.all([
      rpc("tools/call", { name: "get_issue", arguments: {} }, { app: limited }),
      rpc("tools/call", { name: "get_issue", arguments: {} }, { app: limited }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
  });
});
