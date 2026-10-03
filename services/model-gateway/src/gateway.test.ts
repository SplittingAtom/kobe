import { randomUUID } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SecretBox, VIRTUAL_KEY_PURPOSE, virtualKeyContext, type GatewayPrincipal } from "@kobe/db";
import type { SessionTokenAudience } from "@kobe/protocol";
import { signSessionToken, verifySessionToken } from "@kobe/session-token";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createModelGateway } from "./gateway.js";
import { CallLimiter } from "./limits.js";
import { PrincipalCache } from "./principals.js";
import { OPEN_GATE, type CallGate, type CallRecord } from "./seams.js";

const KEY = "m".repeat(40);
const OTHER_KEY = "e".repeat(40);
const box = new SecretBox("v".repeat(40), VIRTUAL_KEY_PURPOSE);
const team = randomUUID();
const user = randomUUID();
const sandbox = randomUUID();
const logger = pino({ level: "silent" });

function token(
  over: Partial<{ aud: SessionTokenAudience; exp: number; sub: string; key: string }> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: over.aud ?? "kobe.model-gateway",
      sub: over.sub ?? sandbox,
      team_id: team,
      user_id: user,
      iat: now - 10,
      exp: over.exp ?? now + 900,
      jti: randomUUID().replace(/-/g, ""),
    },
    over.key ?? KEY,
  );
}

/** Fake Bifrost: knows some virtual keys; records what reached it; streams on request. */
interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let bifrost: Server;
let bifrostUrl = "";
const hits: Hit[] = [];
const knownVks = new Set<string>();
let upstreamClosedEarly = 0;

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
      const vk = req.headers["x-bf-vk"];
      if (typeof vk !== "string" || !knownVks.has(vk)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "access_not_found", error: { message: "no such key" } }));
        return;
      }
      if (Buffer.concat(chunks).toString().includes('"model":"blocked"')) {
        res.writeHead(403, { "content-type": "application/json", "x-bf-internal": "1" });
        res.end(JSON.stringify({ type: "model_blocked", error: { message: "not allowed" } }));
        return;
      }
      if (
        req.url?.startsWith("/v1/chat/completions") &&
        chunks.join("").includes('"stream":true')
      ) {
        res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "x=1" });
        res.write("data: one\n\n");
        const t = setTimeout(() => {
          res.write("data: two\n\n");
          res.end("data: [DONE]\n\n");
        }, 300);
        res.on("close", () => {
          if (!res.writableFinished) {
            upstreamClosedEarly++;
            clearTimeout(t);
          }
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((r) => bifrost.listen(0, "127.0.0.1", r));
  bifrostUrl = `http://127.0.0.1:${(bifrost.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => bifrost.close(() => r())));

// Per test: the principal store, the shim, and what it recorded.
let principal: GatewayPrincipal;
let vkValue = "";
let keyRequests = 0;
let leased = new Set<string>();
let records: CallRecord[] = [];
let forgot = 0;
let gate: CallGate = OPEN_GATE;
let shim: Server;
let base = "";
const cacheTtl = 0;
/** After the first load, the store returns this (the sync stored a new key meanwhile). */
let afterFirstLoad: GatewayPrincipal | undefined;
let loads = 0;

function setVk(value: string | undefined) {
  vkValue = value ?? "";
  principal = {
    ...principal,
    virtualKey: value
      ? { id: "vk-id", valueEnc: box.seal(value, virtualKeyContext(team, user)) }
      : undefined,
  };
}

beforeEach(async () => {
  hits.length = 0;
  records = [];
  forgot = 0;
  keyRequests = 0;
  leased = new Set();
  gate = OPEN_GATE;
  knownVks.clear();
  principal = { member: true, sandbox: "live", virtualKey: undefined };
  afterFirstLoad = undefined;
  loads = 0;
  setVk(`sk-bf-${randomUUID()}`);
  knownVks.add(vkValue);
  const cache = new PrincipalCache(
    {
      load: async () => (loads++ > 0 && afterFirstLoad ? afterFirstLoad : principal),
      requestKey: async () => {
        keyRequests++;
      },
    },
    box,
    { ttlMs: cacheTtl, keyWaitMs: 1_000, keyPollMs: 20 },
  );
  shim = createModelGateway({
    verify: (t) => verifySessionToken(t, "kobe.model-gateway", KEY),
    principals: cache,
    isRunLeased: async (_t, runId) => leased.has(runId),
    bifrostUrl,
    limiter: new CallLimiter({ perSandbox: 1, total: 10 }),
    gate: { admit: (c) => gate.admit(c) },
    sink: { record: (r) => records.push(r) },
    onBifrostForgotKey: () => {
      forgot++;
    },
    logger,
    settings: { maxBodyBytes: 4096, idleTimeoutMs: 5_000 },
    ready: () => true,
  });
  await new Promise<void>((r) => shim.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(shim.address() as AddressInfo).port}`;
});
afterEach(async () => {
  shim.closeAllConnections();
  await new Promise<void>((r) => shim.close(() => r()));
});

async function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...init.headers },
    ...(init.method === "GET" ? {} : { body: JSON.stringify(init.body ?? { model: "openai/m" }) }),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const bearer = (t = token()) => ({ authorization: `Bearer ${t}` });

describe("authentication", () => {
  it("refuses no token, a forged token, another audience's token and an expired one", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const headers of [
      {},
      { authorization: "Bearer not.a.token" },
      bearer(token({ key: OTHER_KEY })),
      bearer(token({ aud: "kobe.egress-proxy", key: KEY })),
      bearer(token({ exp: now - 1 })),
      { authorization: "Basic a29iZTpwYXNz" },
    ]) {
      const r = await call("/v1/chat/completions", { headers });
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(JSON.parse(r.text).error.code).toBe("invalid_session_token");
    }
    expect(hits).toEqual([]);
  });

  it("refuses two different credentials in one request", async () => {
    const r = await call("/anthropic/v1/messages", {
      headers: { ...bearer(), "x-api-key": token() },
    });
    expect(r.status).toBe(401);
  });

  it("refuses a revoked principal (left the team, sandbox destroyed) after the cache TTL", async () => {
    expect((await call("/v1/chat/completions", { headers: bearer() })).status).toBe(200);
    principal = { ...principal, member: false };
    const r = await call("/anthropic/v1/messages", {
      headers: { "x-api-key": token(), "anthropic-version": "2023-06-01" },
    });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text)).toMatchObject({
      type: "error",
      error: { type: "session_revoked" },
    });
    principal = { ...principal, member: true, sandbox: "revoked" };
    expect((await call("/v1/chat/completions", { headers: bearer() })).status).toBe(401);
    expect(hits).toHaveLength(1);
  });
});

describe("routing", () => {
  it("serves inference paths only: admin API, health, batches and unknown paths are 404", async () => {
    for (const [method, path] of [
      ["GET", "/api/providers"],
      ["POST", "/api/governance/virtual-keys"],
      ["GET", "/health"],
      ["POST", "/anthropic/v1/messages/batches"],
      ["POST", "/v1/files"],
      ["GET", "/v1/chat/completions"],
      ["POST", "/v1/../api/providers"],
      ["POST", "/v1/%2e%2e/api/config"],
      ["POST", "/genai/v1beta/models/x:batchGenerateContent"],
    ] as const) {
      const r = await call(path, { method, headers: bearer() });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    expect(hits).toEqual([]);
  });

  it("forwards with the member's virtual key and only allowlisted headers", async () => {
    const t = token();
    const r = await call(`/v1/chat/completions?key=${t}&foo=bar`, {
      headers: {
        ...bearer(t),
        cookie: "a=b",
        "x-bf-direct-key": "true",
        "x-bf-eh-authorization": "Bearer stolen",
        "x-forwarded-for": "1.2.3.4",
        "openai-beta": "assistants=v2",
        "x-stainless-lang": "js",
      },
    });
    expect(r.status).toBe(200);
    const hit = hits[0];
    expect(hit?.path).toBe("/v1/chat/completions");
    expect(hit?.headers["x-bf-vk"]).toBe(vkValue);
    for (const h of [
      "authorization",
      "cookie",
      "x-bf-direct-key",
      "x-bf-eh-authorization",
      "x-forwarded-for",
    ]) {
      expect(hit?.headers[h], h).toBeUndefined();
    }
    expect(hit?.headers["openai-beta"]).toBe("assistants=v2");
    expect(hit?.headers["x-stainless-lang"]).toBe("js");
    expect(records[0]).toMatchObject({
      teamId: team,
      userId: user,
      sandboxId: sandbox,
      model: "openai/m",
      status: 200,
    });
  });

  it("takes the token from each SDK's header and strips it (Anthropic, Gemini, ?key=)", async () => {
    const anthropic = await call("/anthropic/v1/messages", {
      headers: {
        "x-api-key": token(),
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
    });
    expect(anthropic.status).toBe(200);
    expect(hits[0]?.headers["x-api-key"]).toBeUndefined();
    expect(hits[0]?.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    const gem = await call(
      `/genai/v1beta/models/gemini/gemini-2.5-pro:streamGenerateContent?alt=sse&key=${token()}`,
      { body: { contents: [] } },
    );
    expect(gem.status).toBe(200);
    expect(hits[1]?.path).toBe(
      "/genai/v1beta/models/gemini/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
    expect(records[1]?.model).toBe("gemini/gemini-2.5-pro");
    const goog = await call("/genai/v1beta/models/gemini/g:generateContent", {
      headers: { "x-goog-api-key": token() },
    });
    expect(goog.status).toBe(200);
    expect(hits[2]?.headers["x-goog-api-key"]).toBeUndefined();
  });
});

describe("calls", () => {
  it("streams the response as it arrives, without Bifrost's cookies or x-bf headers", async () => {
    const started = Date.now();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/m", stream: true }),
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(Buffer.from(first?.value ?? []).toString()).toContain("data: one");
    expect(Date.now() - started).toBeLessThan(250);
    let rest = "";
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      rest += Buffer.from(chunk.value).toString();
    }
    expect(rest).toContain("[DONE]");
  });

  it("cancels the upstream call when the sandbox goes away", async () => {
    await new Promise<void>((resolve) => {
      const req = request(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { ...bearer(), "content-type": "application/json" },
      });
      req.on("response", (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.end(JSON.stringify({ model: "openai/m", stream: true }));
    });
    for (let i = 0; i < 50 && upstreamClosedEarly === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(upstreamClosedEarly).toBeGreaterThan(0);
    for (let i = 0; i < 50 && records.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(records[0]?.aborted).toBe(true);
  });

  it("limits concurrent calls per sandbox (429)", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/m", stream: true }),
    });
    const second = await call("/v1/chat/completions", { headers: bearer() });
    expect(second.status).toBe(429);
    await res.text();
    expect((await call("/v1/responses", { headers: bearer(), body: { model: "x" } })).status).toBe(
      200,
    );
  });

  it("passes Bifrost's refusals through (status, body), without its x-bf headers", async () => {
    const r = await call("/v1/chat/completions", { headers: bearer(), body: { model: "blocked" } });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).type).toBe("model_blocked");
    expect(r.headers.get("x-bf-internal")).toBeNull();
    expect(records[0]).toMatchObject({ status: 403, errorType: "model_blocked" });
  });

  it("refuses an oversized body (413) and lets the gate refuse before Bifrost", async () => {
    const big = await call("/v1/chat/completions", {
      headers: bearer(),
      body: { x: "a".repeat(5000) },
    });
    expect(big.status).toBe(413);
    gate = {
      admit: async () => ({
        ok: false,
        status: 402,
        code: "budget_exhausted",
        message: "Team budget reached",
      }),
    };
    const refused = await call("/v1/chat/completions", { headers: bearer() });
    expect(refused.status).toBe(402);
    expect(JSON.parse(refused.text).error.code).toBe("budget_exhausted");
    expect(hits).toEqual([]);
  });

  it("attributes a run only when it is leased to this sandbox", async () => {
    const runId = randomUUID();
    expect(
      (await call("/v1/chat/completions", { headers: { ...bearer(), "x-kobe-run-id": runId } }))
        .status,
    ).toBe(403);
    leased.add(runId);
    expect(
      (await call("/v1/chat/completions", { headers: { ...bearer(), "x-kobe-run-id": runId } }))
        .status,
    ).toBe(200);
    expect(hits[0]?.headers["x-kobe-run-id"]).toBeUndefined();
    expect(records.at(-1)?.runId).toBe(runId);
    expect(
      (await call("/v1/chat/completions", { headers: { ...bearer(), "x-kobe-run-id": "nope" } }))
        .status,
    ).toBe(400);
  });
});

describe("virtual keys", () => {
  it("asks the sync for a missing key and uses it once it appears", async () => {
    setVk(undefined);
    const fresh = `sk-bf-${randomUUID()}`;
    knownVks.add(fresh);
    setTimeout(() => setVk(fresh), 100);
    const r = await call("/v1/chat/completions", { headers: bearer() });
    expect(r.status).toBe(200);
    expect(keyRequests).toBe(1);
    expect(hits[0]?.headers["x-bf-vk"]).toBe(fresh);
  });

  it("answers 503 with Retry-After when no key appears, asking the sync at most once", async () => {
    setVk(undefined);
    const r = await call("/v1/chat/completions", { headers: bearer() });
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect((await call("/v1/chat/completions", { headers: bearer() })).status).toBe(503);
    expect(keyRequests).toBe(1);
  }, 10_000);

  it("when Bifrost forgot the key: requests a resync and retries once with the new key", async () => {
    const old = vkValue;
    const rotated = `sk-bf-${randomUUID()}`;
    setVk(rotated);
    afterFirstLoad = principal;
    setVk(old);
    knownVks.clear();
    knownVks.add(rotated);
    const r = await call("/v1/chat/completions", { headers: bearer() });
    expect(r.status).toBe(200);
    expect(forgot).toBe(1);
    expect(hits.map((h) => h.headers["x-bf-vk"])).toEqual([old, rotated]);
  });

  it("answers 503 (resyncing) when the stored key is still unknown to Bifrost", async () => {
    knownVks.clear();
    const r = await call("/v1/chat/completions", { headers: bearer() });
    expect(r.status).toBe(503);
    expect(forgot).toBe(1);
    expect(JSON.parse(r.text).error.code).toBe("model_gateway_resyncing");
  });
});
