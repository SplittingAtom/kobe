import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SecretBox, VIRTUAL_KEY_PURPOSE, virtualKeyContext, type GatewayPrincipal } from "@kobe/db";
import {
  RUN_TOKEN_HEADER,
  SERVER_CALL_AUDIENCE,
  SERVER_CALL_LIMITS,
  SERVER_CALL_RESPONSE_FORMATS,
  SERVER_CALL_TOKEN_HEADER,
  type ServerCallClaims,
} from "@kobe/protocol";
import {
  deriveRunTokenKey,
  deriveServerCallTokenKey,
  signRunToken,
  signServerCallToken,
} from "@kobe/protocol/node";
import { signSessionToken, verifySessionToken } from "@kobe/session-token";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createModelGateway } from "./gateway.js";
import { ByteBudget, CallLimiter, RequestRate } from "./limits.js";
import { PrincipalCache } from "./principals.js";
import { ServerCallReplay } from "./server-call.js";
import { OPEN_GATE, type CallContext, type CallGate, type CallRecord } from "./seams.js";

/**
 * KOBE-234 ac-2: the server-call identity. A title/follow-ups token works only as a server call
 * (its own header, alone, a plain chat completion of its model); it is no sandbox credential, and
 * no sandbox credential works as one. Provider keys never leave Bifrost: the gateway forwards with
 * the member's virtual key, and neither the token nor any `x-bf-*` header crosses.
 */
const SESSION_KEY = "m".repeat(40);
const MASTER = new TextEncoder().encode(SESSION_KEY);
const SC_KEY = deriveServerCallTokenKey(MASTER);
const RUN_KEY = deriveRunTokenKey(MASTER);
const box = new SecretBox("v".repeat(40), VIRTUAL_KEY_PURPOSE);
const team = randomUUID();
const user = randomUUID();
const sandbox = randomUUID();
const thread = randomUUID();
const run = randomUUID();
const MODEL = "openai/m";
const logger = pino({ level: "silent" });

const now = () => Math.floor(Date.now() / 1000);

function serverToken(over: Partial<ServerCallClaims> = {}, key = SC_KEY): string {
  return signServerCallToken(key, {
    iss: "kobe-server",
    aud: SERVER_CALL_AUDIENCE,
    purpose: "title",
    team_id: team,
    user_id: user,
    thread_id: thread,
    run_id: run,
    model: MODEL,
    max_output_tokens: 48,
    iat: now() - 1,
    exp: now() + 29,
    jti: randomUUID(),
    ...over,
  });
}

function sessionToken(): string {
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: "kobe.model-gateway",
      sub: sandbox,
      team_id: team,
      user_id: user,
      iat: now() - 10,
      exp: now() + 900,
      jti: randomUUID().replace(/-/g, ""),
    },
    SESSION_KEY,
  );
}

function runToken(): string {
  return signRunToken(RUN_KEY, {
    iss: "kobe-server",
    aud: "kobe.model-gateway",
    run_id: run,
    team_id: team,
    sandbox_id: sandbox,
    iat: now() - 1,
    exp: now() + 900,
    jti: randomUUID(),
  }).token;
}

const BODY = {
  model: MODEL,
  messages: [
    { role: "system", content: "Title this conversation in at most six words." },
    { role: "user", content: "How did revenue move by region last quarter?" },
  ],
  max_tokens: 48,
};

interface Hit {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
let bifrost: Server;
let bifrostUrl = "";
const hits: Hit[] = [];
let vk = "";

beforeAll(async () => {
  bifrost = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push({
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (req.headers["x-bf-vk"] !== vk) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "access_not_found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "x-bf-provider-key": "pk-1" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Revenue by region" } }],
          usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 },
        }),
      );
    });
  });
  await new Promise<void>((r) => bifrost.listen(0, "127.0.0.1", r));
  bifrostUrl = `http://127.0.0.1:${(bifrost.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => bifrost.close(() => r())));

let principal: GatewayPrincipal;
let loadedSandboxes: (string | undefined)[] = [];
let records: CallRecord[] = [];
let admitted: CallContext[] = [];
let gate: CallGate = OPEN_GATE;
let runMatches = true;
let runChecks: unknown[] = [];
let shim: Server;
let base = "";

beforeEach(async () => {
  hits.length = 0;
  records = [];
  admitted = [];
  loadedSandboxes = [];
  gate = OPEN_GATE;
  runMatches = true;
  runChecks = [];
  vk = `sk-bf-${randomUUID()}`;
  principal = {
    member: true,
    sandbox: "live",
    virtualKey: { id: "vk-id", valueEnc: box.seal(vk, virtualKeyContext(team, user)) },
    enabledModels: [MODEL, "openai/other"],
  };
  const principals = new PrincipalCache(
    {
      load: async (_t, _u, sandboxId) => {
        loadedSandboxes.push(sandboxId);
        return principal;
      },
      requestKey: async () => undefined,
    },
    box,
    { ttlMs: 0 },
  );
  shim = createModelGateway({
    verify: (t) => verifySessionToken(t, "kobe.model-gateway", SESSION_KEY),
    principals,
    isRunLeased: async () => true,
    runTokens: { key: RUN_KEY, isActive: async () => true, require: false },
    serverCalls: {
      key: SC_KEY,
      replay: new ServerCallReplay(),
      runMatches: async (c) => {
        runChecks.push(c);
        return runMatches;
      },
      limiter: new CallLimiter({ perSandbox: 2, total: 4 }),
      rate: new RequestRate({ burst: 1000, perSecond: 1000 }),
    },
    bifrostUrl,
    limiter: new CallLimiter({ perSandbox: 4, total: 10 }),
    bytes: new ByteBudget({ perSandbox: 1 << 20, total: 1 << 21 }),
    rate: new RequestRate({ burst: 1000, perSecond: 1000 }),
    gate: {
      admit: (c) => {
        admitted.push(c);
        return gate.admit(c);
      },
    },
    sink: { record: (r) => records.push(r) },
    onBifrostForgotKey: () => undefined,
    logger,
    settings: { maxBodyBytes: 1 << 20, idleTimeoutMs: 5_000 },
    ready: () => true,
  });
  await new Promise<void>((r) => shim.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(shim.address() as AddressInfo).port}`;
});
afterEach(async () => {
  shim.closeAllConnections();
  await new Promise<void>((r) => shim.close(() => r()));
});

async function post(path: string, headers: Record<string, string>, body: unknown = BODY) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const code = (() => {
    try {
      const e = (JSON.parse(text) as { error?: { code?: string; type?: string } }).error;
      return e?.code ?? e?.type; // Anthropic-shaped errors name the code `type`
    } catch {
      return undefined;
    }
  })();
  return { status: res.status, headers: res.headers, text, code };
}
const asServer = (t = serverToken()) => ({ [SERVER_CALL_TOKEN_HEADER]: t });

describe("server calls: accepted (KOBE-234)", () => {
  it("forwards a title call with the member's virtual key; keys and token stay gateway-side", async () => {
    const r = await post("/v1/chat/completions", asServer());
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).choices[0].message.content).toBe("Revenue by region");
    // Bifrost's own headers (which could name provider keys) never come back.
    expect([...r.headers.keys()].filter((h) => h.startsWith("x-bf-"))).toEqual([]);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.headers["x-bf-vk"]).toBe(vk);
    expect(hit?.headers[SERVER_CALL_TOKEN_HEADER]).toBeUndefined();
    expect(hit?.headers.authorization).toBeUndefined();
    expect(JSON.parse(hit?.body ?? "{}")).toEqual(BODY);
    // No sandbox: the principal is loaded without one; the triggering run attributes the call.
    expect(loadedSandboxes).toEqual([undefined]);
    expect(admitted[0]).toMatchObject({
      teamId: team,
      userId: user,
      sandboxId: undefined,
      runId: run,
      purpose: "title",
      model: MODEL,
      outputAllowance: 48,
    });
    await expect.poll(() => records.length).toBe(1);
    expect(records[0]).toMatchObject({
      purpose: "title",
      sandboxId: undefined,
      runId: run,
      status: 200,
      usage: { source: "reported", counts: { input: 30, output: 4 } },
    });
  });

  it("does not depend on a sandbox: a member whose sandbox is gone can still be titled", async () => {
    principal = { ...principal, sandbox: "revoked" };
    expect((await post("/v1/chat/completions", asServer())).status).toBe(200);
  });

  it("runs the call through the budget gate (a refusal there is final)", async () => {
    gate = {
      admit: async () => ({
        ok: false,
        status: 402,
        code: "budget_soft_limit",
        message: "skipped",
      }),
    };
    const r = await post("/v1/chat/completions", asServer(serverToken({ purpose: "followups" })));
    expect([r.status, r.code]).toEqual([402, "budget_soft_limit"]);
    expect(hits).toEqual([]);
  });
});

describe("server calls: the eval judge (KOBE-326 ac-2)", () => {
  const judgeToken = (over: Partial<ServerCallClaims> = {}) =>
    serverToken({ purpose: "eval_judge", max_output_tokens: 512, ...over });
  const judgeBody = (content: string, extra: object = {}) => ({
    model: MODEL,
    messages: [
      { role: "system", content: "You grade one run of an AI agent against a rubric." },
      { role: "user", content },
    ],
    max_tokens: 512,
    temperature: 0,
    ...extra,
  });

  it("forwards a judge call, larger than an epilogue's, and records it as eval_judge under the token's identity", async () => {
    const data = "x".repeat(100_000);
    const body = judgeBody(data, { response_format: SERVER_CALL_RESPONSE_FORMATS.eval_judge });
    const r = await post("/v1/chat/completions", asServer(judgeToken()), body);
    expect(r.status).toBe(200);
    expect(JSON.parse(hits[0]?.body ?? "{}")).toEqual(body);
    expect(hits[0]?.headers["x-bf-vk"]).toBe(vk);
    expect(loadedSandboxes).toEqual([undefined]);
    expect(runChecks).toEqual([{ teamId: team, runId: run, threadId: thread, userId: user }]);
    await expect.poll(() => records.length).toBe(1);
    // The ledger row: the token's member, run and purpose; no sandbox (gateway identity).
    expect(records[0]).toMatchObject({
      purpose: "eval_judge",
      teamId: team,
      userId: user,
      sandboxId: undefined,
      runId: run,
      model: MODEL,
      status: 200,
    });
  });

  it("takes only the judge's own response format, and no epilogue call takes one", async () => {
    const format = SERVER_CALL_RESPONSE_FORMATS.eval_judge;
    const title = await post("/v1/chat/completions", asServer(), {
      ...BODY,
      response_format: format,
    });
    expect([title.status, title.code]).toEqual([400, "server_call_body_refused"]);
    const other = await post(
      "/v1/chat/completions",
      asServer(judgeToken()),
      judgeBody("data", {
        response_format: {
          ...format,
          json_schema: { ...format.json_schema, schema: { type: "object" } },
        },
      }),
    );
    expect([other.status, other.code]).toEqual([400, "server_call_body_refused"]);
    expect(hits).toEqual([]);
  });

  it("pins the judge's temperature to 0 (review L4)", async () => {
    for (const temperature of [0.2, 1, undefined]) {
      const r = await post(
        "/v1/chat/completions",
        asServer(judgeToken()),
        judgeBody("data", { temperature }),
      );
      expect([r.status, r.code], String(temperature)).toEqual([400, "server_call_body_refused"]);
    }
    expect(hits).toEqual([]);
    expect(
      (await post("/v1/chat/completions", asServer(judgeToken()), judgeBody("d"))).status,
    ).toBe(200);
  });

  it("keeps the epilogue's message cap for titles, and the judge's own above it", async () => {
    const long = "x".repeat(SERVER_CALL_LIMITS.title.max_message_chars + 1);
    const title = await post("/v1/chat/completions", asServer(), {
      ...BODY,
      messages: [{ role: "user", content: long }],
    });
    expect([title.status, title.code]).toEqual([400, "server_call_body_refused"]);
    const judge = await post("/v1/chat/completions", asServer(judgeToken()), judgeBody(long));
    expect(judge.status).toBe(200);
    expect(() => judgeToken({ max_output_tokens: 513 })).not.toThrow();
    const over = await post(
      "/v1/chat/completions",
      asServer(judgeToken({ max_output_tokens: 513 })),
      judgeBody("data", { max_tokens: 513 }),
    );
    expect([over.status, over.code]).toEqual([400, "server_call_body_refused"]);
  });
});

describe("server calls: refused (KOBE-234 ac-2)", () => {
  it("a server-call token is no sandbox credential (API-key headers or the run-token header)", async () => {
    const t = serverToken();
    for (const headers of [
      { authorization: `Bearer ${t}` },
      { "x-api-key": t },
      { authorization: `Bearer ${sessionToken()}`, [RUN_TOKEN_HEADER]: t },
    ]) {
      const r = await post("/v1/chat/completions", headers);
      expect(r.status, JSON.stringify(Object.keys(headers))).toBe(401);
      expect(["invalid_session_token", "invalid_run_token"]).toContain(r.code);
    }
    expect(hits).toEqual([]);
  });

  it("no sandbox credential is a server-call token (session token, run token, forged key)", async () => {
    const wrongKey = serverToken({}, deriveRunTokenKey(MASTER));
    for (const t of [sessionToken(), runToken(), wrongKey, "ksc1.e30.x"]) {
      const r = await post("/v1/chat/completions", asServer(t));
      expect([r.status, r.code]).toEqual([401, "invalid_server_call_token"]);
    }
    expect(hits).toEqual([]);
  });

  it("refuses a server-call token next to any sandbox credential", async () => {
    for (const extra of [
      { authorization: `Bearer ${sessionToken()}` },
      { "x-goog-api-key": "k" },
      { [RUN_TOKEN_HEADER]: runToken() },
      { "x-kobe-run-id": run },
    ]) {
      const r = await post("/v1/chat/completions", { ...asServer(), ...extra });
      expect([r.status, r.code]).toEqual([400, "ambiguous_credentials"]);
    }
    const r = await post("/v1/chat/completions?key=k", asServer());
    expect([r.status, r.code]).toEqual([400, "ambiguous_credentials"]);
    expect(hits).toEqual([]);
  });

  it("refuses an expired token and a replay of a used one", async () => {
    const expired = serverToken({ iat: now() - 20, exp: now() - 1 });
    expect((await post("/v1/chat/completions", asServer(expired))).code).toBe(
      "invalid_server_call_token",
    );
    const once = serverToken();
    expect((await post("/v1/chat/completions", asServer(once))).status).toBe(200);
    const again = await post("/v1/chat/completions", asServer(once));
    expect([again.status, again.code]).toEqual([401, "server_call_token_replayed"]);
    expect(hits).toHaveLength(1);
  });

  it("allows only a plain chat completion: no tools, streaming, other routes or shapes", async () => {
    const refusedBodies: unknown[] = [
      { ...BODY, tools: [{ type: "function", function: { name: "shell" } }] },
      { ...BODY, tool_choice: "auto" },
      { ...BODY, messages: [{ role: "tool", content: "x", tool_call_id: "1" }] },
      { ...BODY, stream: true },
      { ...BODY, n: 2 },
      { ...BODY, max_tokens: undefined },
      { ...BODY, messages: [{ role: "user", content: [{ type: "image_url" }] }] },
      "not json",
    ];
    for (const body of refusedBodies) {
      const r = await post("/v1/chat/completions", asServer(), body);
      expect([r.status, r.code], JSON.stringify(body)).toEqual([400, "server_call_body_refused"]);
    }
    for (const path of ["/v1/responses", "/anthropic/v1/messages"]) {
      const r = await post(path, asServer());
      expect([r.status, r.code]).toEqual([403, "server_call_route_refused"]);
    }
    expect(hits).toEqual([]);
  });

  it("allows only the token's model, within its output cap, and only if the team enabled it", async () => {
    const other = await post("/v1/chat/completions", asServer(), {
      ...BODY,
      model: "openai/other",
    });
    expect([other.status, other.code]).toEqual([400, "server_call_body_refused"]);
    const over = await post("/v1/chat/completions", asServer(), { ...BODY, max_tokens: 49 });
    expect([over.status, over.code]).toEqual([400, "server_call_body_refused"]);
    principal = { ...principal, enabledModels: ["openai/other"] };
    const disabled = await post("/v1/chat/completions", asServer());
    expect([disabled.status, disabled.code]).toEqual([403, "model_not_enabled"]);
    expect(hits).toEqual([]);
  });

  it("gives the reasoning headroom and an effort only to a catalog reasoning model (KOBE-219 H1)", async () => {
    const big = SERVER_CALL_LIMITS.title.reasoning_max_output_tokens;
    const reasoningBody = { ...BODY, max_tokens: big, reasoning_effort: "low" };
    const token = () => serverToken({ max_output_tokens: big });
    // Not marked as reasoning: neither the larger cap nor the field, whatever the token says.
    const plainBig = await post("/v1/chat/completions", asServer(token()), {
      ...BODY,
      max_tokens: big,
    });
    expect([plainBig.status, plainBig.code]).toEqual([400, "server_call_body_refused"]);
    const plainEffort = await post("/v1/chat/completions", asServer(), {
      ...BODY,
      reasoning_effort: "low",
    });
    expect([plainEffort.status, plainEffort.code]).toEqual([400, "server_call_body_refused"]);
    expect(hits).toEqual([]);
    // Marked: both pass, the allowance is the larger cap, and nothing above it.
    principal = { ...principal, reasoningModels: [MODEL] };
    const ok = await post("/v1/chat/completions", asServer(token()), reasoningBody);
    expect(ok.status).toBe(200);
    expect(JSON.parse(hits[0]?.body ?? "{}")).toEqual(reasoningBody);
    expect(admitted.at(-1)).toMatchObject({ outputAllowance: big });
    expect(() => serverToken({ max_output_tokens: big + 1 })).toThrow();
  });

  it("refuses a token whose run is not a completed run of its thread and member (review L1)", async () => {
    runMatches = false;
    const r = await post("/v1/chat/completions", asServer());
    expect([r.status, r.code]).toEqual([403, "server_call_run_mismatch"]);
    expect(runChecks).toEqual([{ teamId: team, runId: run, threadId: thread, userId: user }]);
    expect(hits).toEqual([]);
  });

  it("refuses a body over the server-call limit (64 KiB)", async () => {
    const big = { ...BODY, messages: [{ role: "user", content: "x".repeat(70_000) }] };
    const r = await post("/v1/chat/completions", asServer(), big);
    expect(r.status).toBe(413);
    expect(hits).toEqual([]);
  });

  it("refuses a member who left the team", async () => {
    principal = { ...principal, member: false };
    const r = await post("/v1/chat/completions", asServer());
    expect([r.status, r.code]).toEqual([401, "session_revoked"]);
  });
});

describe("ServerCallReplay", () => {
  it("allows a jti once, forgets it after expiry, and fails closed when full", () => {
    const replay = new ServerCallReplay(2);
    expect(replay.claim("a", 100, 50)).toBe(true);
    expect(replay.claim("a", 100, 60)).toBe(false);
    expect(replay.claim("b", 100, 60)).toBe(true);
    // Full of live entries: refused rather than forgetting one.
    expect(replay.claim("c", 100, 60)).toBe(false);
    // Once they expired, room again (and "a" is not a replay any more: its token has expired).
    expect(replay.claim("c", 200, 100)).toBe(true);
  });
});

describe("server calls: their own limits (review L4)", () => {
  it("a team's busy sandboxes do not use up the server calls' concurrency, and vice versa", async () => {
    // The sandbox limiter is per sandbox (4 here); server calls have their own per-team limiter (2).
    // Two slow server calls hold both server slots; a third is refused, while a sandbox call passes.
    gate = {
      admit: async () => {
        await new Promise((r) => setTimeout(r, 300));
        return { ok: true };
      },
    };
    const slow = [
      post("/v1/chat/completions", asServer()),
      post("/v1/chat/completions", asServer()),
    ];
    await new Promise((r) => setTimeout(r, 100));
    const third = await post("/v1/chat/completions", asServer());
    expect([third.status, third.code]).toEqual([429, "too_many_concurrent_calls"]);
    const sandboxCall = post(
      "/v1/chat/completions",
      { authorization: `Bearer ${sessionToken()}` },
      { model: MODEL, messages: [] },
    );
    expect((await sandboxCall).status).toBe(200);
    expect((await Promise.all(slow)).map((r) => r.status)).toEqual([200, 200]);
  });
});
