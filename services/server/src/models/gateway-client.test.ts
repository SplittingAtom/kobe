import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  SERVER_CALL_AUDIENCE,
  SERVER_CALL_LIMITS,
  SERVER_CALL_PATH,
  SERVER_CALL_RESPONSE_FORMATS,
  SERVER_CALL_TOKEN_HEADER,
  runRootSpanId,
  runTraceId,
  serverCallRequestSchema,
} from "@kobe/protocol";
import { InMemorySpanExporter, initTelemetry } from "@kobe/telemetry";
import { generateSessionKeyPair, verifyServerCallToken } from "@kobe/session-token";
import {
  createServerCallClient,
  ServerCallError,
  serverCallKeyFromEnv,
  type ServerCallInput,
} from "./gateway-client.js";

/**
 * KOBE-219 ac-8 (KOBE-234 contract): the server's call to the model gateway carries the
 * server-call token in its own header and nothing else that is a credential — no session token,
 * no run token or run id, no provider key — and the body is one the gateway accepts.
 */
const PAIR = generateSessionKeyPair();
const KEY = PAIR.signing;
/** A distinctive slice of the private key: never on the wire. */
const MASTER = PAIR.privatePem.slice(30, 70);
// Secrets the server process holds that must never reach the gateway on this path.
const PROVIDER_KEY_SECRET = "p".repeat(48);
const PROVIDER_KEY = "sk-provider-0123456789abcdef";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let server: Server;
let base = "";
const seen: Seen[] = [];
let reply: (res: ServerResponse) => void = () => undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      reply(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  seen.length = 0;
});

const ok =
  (content: unknown, finish_reason = "stop") =>
  (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason }] }),
    );
  };

const input = (over: Partial<ServerCallInput> = {}): ServerCallInput => ({
  purpose: "title",
  teamId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  userId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
  threadId: "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f",
  runId: "4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f80",
  model: "openai/gpt-x",
  reasoning: false,
  messages: [{ role: "user", content: "What drives revenue?" }],
  signal: AbortSignal.timeout(5_000),
  ...over,
});

describe("server-call gateway client: the eval judge (KOBE-326)", () => {
  it("asks at temperature 0, the judge's cap, and its structured format only when told", async () => {
    reply = ok('{"passed": true, "reason": "ok"}');
    const client = createServerCallClient({ url: base, key: KEY });
    await client.complete(input({ purpose: "eval_judge", structured: true }));
    await client.complete(input({ purpose: "eval_judge" }));
    await client.complete(input({ structured: true }));
    const bodies = seen.map((s) => serverCallRequestSchema.parse(JSON.parse(s.body)));
    expect(bodies[0]).toMatchObject({
      temperature: 0,
      max_tokens: SERVER_CALL_LIMITS.eval_judge.max_output_tokens,
      response_format: SERVER_CALL_RESPONSE_FORMATS.eval_judge,
    });
    expect(bodies[1]).toMatchObject({ temperature: 0 });
    expect(bodies[1]).not.toHaveProperty("response_format");
    // A title never asks for a format, and keeps its own temperature.
    expect(bodies[2]).toMatchObject({ temperature: SERVER_CALL_LIMITS.title.temperature });
    expect(bodies[2]).not.toHaveProperty("response_format");
    const claims = verifyServerCallToken(
      PAIR.verify,
      seen[0]?.headers[SERVER_CALL_TOKEN_HEADER],
      Math.floor(Date.now() / 1000),
    );
    expect(claims.ok && claims.claims.purpose).toBe("eval_judge");
  });
});

describe("server-call gateway client (KOBE-219 ac-4, ac-8)", () => {
  it("sends the server-call token alone, non-streaming, to POST /v1/chat/completions", async () => {
    reply = ok("Revenue drivers");
    const client = createServerCallClient({ url: base, key: KEY });
    expect(await client.complete(input())).toBe("Revenue drivers");

    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe(SERVER_CALL_PATH);
    const body = serverCallRequestSchema.parse(JSON.parse(req?.body ?? ""));
    expect(body).toMatchObject({ model: "openai/gpt-x", stream: false });
    expect(body.max_tokens).toBeLessThanOrEqual(SERVER_CALL_LIMITS.title.max_output_tokens);

    const token = req?.headers[SERVER_CALL_TOKEN_HEADER];
    const verified = verifyServerCallToken(PAIR.verify, token, Math.floor(Date.now() / 1000));
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims).toMatchObject({
      aud: SERVER_CALL_AUDIENCE,
      purpose: "title",
      team_id: input().teamId,
      user_id: input().userId,
      thread_id: input().threadId,
      run_id: input().runId,
      model: "openai/gpt-x",
      max_output_tokens: SERVER_CALL_LIMITS.title.max_output_tokens,
    });
    expect(verified.claims.exp - verified.claims.iat).toBeLessThanOrEqual(30);
  });

  it("never sends a session token, run token, run id or provider key", async () => {
    reply = ok("Revenue drivers");
    process.env.KOBE_MODELS_PROVIDER_KEY_SECRET = PROVIDER_KEY_SECRET;
    try {
      const client = createServerCallClient({ url: base, key: KEY });
      await client.complete(input());
    } finally {
      delete process.env.KOBE_MODELS_PROVIDER_KEY_SECRET;
    }
    const [req] = seen;
    const names = Object.keys(req?.headers ?? {}).sort();
    // Only transport headers, the token, and (when tracing is on) the trace context.
    const allowed = new Set([
      "connection",
      "content-length",
      "content-type",
      "host",
      "accept",
      "accept-encoding",
      "accept-language",
      "sec-fetch-mode",
      "user-agent",
      "traceparent",
      "tracestate",
      SERVER_CALL_TOKEN_HEADER,
    ]);
    expect(names.filter((n) => !allowed.has(n))).toEqual([]);
    for (const credential of [
      "authorization",
      "x-api-key",
      "x-goog-api-key",
      "api-key",
      "x-kobe-run-token",
      "x-kobe-run-id",
    ]) {
      expect(req?.headers[credential]).toBeUndefined();
    }
    expect(req?.url).not.toContain("key=");
    const everything = JSON.stringify(req);
    for (const secret of [MASTER, PROVIDER_KEY_SECRET, PROVIDER_KEY]) {
      expect(everything).not.toContain(secret);
    }
    // The token is not a session token (JWT) nor a run token.
    expect(String(req?.headers[SERVER_CALL_TOKEN_HEADER])).toMatch(
      /^eyJ[\w-]+\.[\w-]+\.[\w-]{86}$/,
    );
  });

  it("asks a reasoning model for a low effort within the reasoning headroom (review H1)", async () => {
    reply = ok("Revenue drivers");
    const client = createServerCallClient({ url: base, key: KEY });
    await client.complete(input({ reasoning: true }));
    const body = serverCallRequestSchema.parse(JSON.parse(seen[0]?.body ?? ""));
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_tokens).toBe(SERVER_CALL_LIMITS.title.reasoning_max_output_tokens);
    const verified = verifyServerCallToken(
      PAIR.verify,
      seen[0]?.headers[SERVER_CALL_TOKEN_HEADER],
      Math.floor(Date.now() / 1000),
    );
    expect(verified.ok && verified.claims.max_output_tokens).toBe(
      SERVER_CALL_LIMITS.title.reasoning_max_output_tokens,
    );
    // A model the catalog does not mark gets no effort field at all.
    seen.length = 0;
    await client.complete(input());
    expect(JSON.parse(seen[0]?.body ?? "{}")).not.toHaveProperty("reasoning_effort");
  });

  it.each([
    ["", "stop", "empty_content"],
    ["   \n ", "stop", "empty_content"],
    [null, "stop", "empty_content"],
    ["Analyse des ventes trimest", "length", "truncated"],
  ])("does not use a reply %j (finish %s): %s, with the model", async (content, finish, code) => {
    reply = ok(content, finish);
    const client = createServerCallClient({ url: base, key: KEY });
    const err = (await client.complete(input()).catch((e: unknown) => e)) as ServerCallError;
    expect(err).toBeInstanceOf(ServerCallError);
    expect(err.code).toBe(code);
    expect(err.unusable).toBe(true);
    expect(err.model).toBe("openai/gpt-x");
  });

  it("reports a refusal by the gateway's code, never its text", async () => {
    reply = (res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "budget_exhausted", message: "secret text" } }));
    };
    const client = createServerCallClient({ url: base, key: KEY });
    const err = await client.complete(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerCallError);
    expect((err as ServerCallError).code).toBe("budget_exhausted");
    expect((err as ServerCallError).status).toBe(402);
    expect(String((err as Error).message)).not.toContain("secret text");
  });

  it("falls back to the status when the refusal names no usable code", async () => {
    reply = (res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("upstream down: Bearer abc");
    };
    const client = createServerCallClient({ url: base, key: KEY });
    const err = (await client.complete(input()).catch((e: unknown) => e)) as ServerCallError;
    expect(err.code).toBe("http_503");
  });

  it("refuses a reply without text and stops at the timeout", async () => {
    reply = ok([{ type: "image" }]);
    const client = createServerCallClient({ url: base, key: KEY });
    const bad = (await client.complete(input()).catch((e: unknown) => e)) as ServerCallError;
    expect(bad.code).toBe("empty_content");
    reply = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [] }));
    };
    const shapeless = (await client.complete(input()).catch((e: unknown) => e)) as ServerCallError;
    expect(shapeless.code).toBe("bad_reply");

    reply = () => undefined; // never answers
    const slow = (await client
      .complete(input({ signal: AbortSignal.timeout(50) }))
      .catch((e: unknown) => e)) as ServerCallError;
    expect(slow.code).toBe("timeout");
  });

  it("does not follow redirects (the token never leaves for another host)", async () => {
    reply = (res) => {
      res.writeHead(307, { location: "http://169.254.169.254/" });
      res.end();
    };
    const client = createServerCallClient({ url: base, key: KEY });
    const err = (await client.complete(input()).catch((e: unknown) => e)) as ServerCallError;
    expect(err.code).toMatch(/^(http_307|unreachable)$/);
    expect(seen).toHaveLength(1);
  });

  it("signs with the model-gateway Ed25519 private key only (KOBE-521)", () => {
    expect(serverCallKeyFromEnv({})).toBeUndefined();
    expect(
      serverCallKeyFromEnv({ KOBE_SESSION_SIGNING_KEY_MODEL_GATEWAY: "not a pem" }),
    ).toBeUndefined();
    // The retired shared master secret no longer yields a key.
    expect(
      serverCallKeyFromEnv({ KOBE_SESSION_KEY_MODEL_GATEWAY: "m".repeat(48) }),
    ).toBeUndefined();
    expect(
      serverCallKeyFromEnv({ KOBE_SESSION_SIGNING_KEY_MODEL_GATEWAY: PAIR.privatePem })?.kid,
    ).toBe(KEY.kid);
  });

  it("mints an EdDSA token the public key verifies and another key does not", async () => {
    const client = createServerCallClient({ url: base, key: KEY });
    // The stub's reply does not matter here: the token on the request does.
    await client.complete(input()).catch(() => undefined);
    const token = String(seen.at(-1)?.headers[SERVER_CALL_TOKEN_HEADER]);
    const now = Math.floor(Date.now() / 1000);
    expect(verifyServerCallToken(PAIR.verify, token, now).ok).toBe(true);
    expect(verifyServerCallToken(generateSessionKeyPair().verify, token, now)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});

describe("tracing (KOBE-274 ac-6)", () => {
  it("records the call in the triggering run's trace with the thread's session", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = initTelemetry(
      {
        enabled: true,
        endpoint: "http://x:4318",
        headers: {},
        captureContent: false,
        serviceName: "t",
      },
      { exporter },
    );
    try {
      reply = ok("A title");
      const call = input();
      await createServerCallClient({ url: base, key: KEY }).complete(call);
      const span = exporter.getFinishedSpans().find((s) => s.name === "server_call.title");
      expect(span?.spanContext().traceId).toBe(runTraceId(call.runId));
      expect(span?.parentSpanContext?.spanId).toBe(runRootSpanId(call.runId));
      expect(span?.attributes).toMatchObject({
        "session.id": call.threadId,
        "user.id": call.userId,
      });
      expect(String(seen[0]?.headers.traceparent)).toContain(runTraceId(call.runId));
    } finally {
      await telemetry.shutdown();
    }
  });
});
