import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerCredentials, type GrantAnswer, type GrantSource } from "./credentials.js";
import { createPolicyServer } from "./server-client.js";

const KEY = "sk-live-0123456789abcdef";
const connector = (auth_kind: "oauth" | "api_key" | "none") => ({
  id: randomUUID(),
  url: "https://mcp.example.com/mcp",
  auth_kind,
});
const request = (auth_kind: "oauth" | "api_key" | "none") => ({
  token: "sandbox-token",
  teamId: randomUUID(),
  userId: randomUUID(),
  connector: connector(auth_kind),
});

function source(answer: GrantAnswer) {
  const asked: { token: string; connectorId: string }[] = [];
  const grants: GrantSource = {
    fetchGrant: (token, connectorId) => {
      asked.push({ token, connectorId });
      return Promise.resolve(answer);
    },
  };
  return { asked, grants };
}

describe("createServerCredentials", () => {
  it("asks for nothing for a connector without credentials", async () => {
    const s = source({ ok: true, value: { kind: "api_key", apiKey: KEY } });
    const out = await createServerCredentials(s.grants).headersFor(request("none"));
    expect(out).toEqual({ ok: true, headers: {} });
    expect(s.asked).toEqual([]);
  });

  it("attaches the user's API key as a bearer token, fetched with the sandbox's own token", async () => {
    const s = source({ ok: true, value: { kind: "api_key", apiKey: KEY } });
    const req = request("api_key");
    const out = await createServerCredentials(s.grants).headersFor(req);
    expect(out).toEqual({ ok: true, headers: { authorization: `Bearer ${KEY}` } });
    expect(s.asked).toEqual([{ token: "sandbox-token", connectorId: req.connector.id }]);
  });

  it.each(["not_connected", "unavailable"] as const)("passes %s through", async (failure) => {
    const out = await createServerCredentials(source({ ok: false, failure }).grants).headersFor(
      request("api_key"),
    );
    expect(out).toEqual({ ok: false, code: failure });
  });

  it("does not serve oauth connectors yet (KOBE-61)", async () => {
    const s = source({ ok: true, value: { kind: "api_key", apiKey: KEY } });
    const out = await createServerCredentials(s.grants).headersFor(request("oauth"));
    expect(out).toEqual({ ok: false, code: "not_connected" });
    expect(s.asked).toEqual([]);
  });
});

describe("policy server grant client", () => {
  const seen: { path: string; headers: Headers }[] = [];
  const respond = (status: number, body: unknown): typeof fetch =>
    ((url: string, init: RequestInit) => {
      seen.push({ path: new URL(url).pathname, headers: new Headers(init.headers) });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as unknown as typeof fetch;
  const client = (f: typeof fetch, errors: unknown[] = []) =>
    createPolicyServer({
      baseUrl: "http://server:8082",
      internalKey: "i".repeat(40),
      timeoutMs: 1000,
      fetch: f,
      onError: (e) => errors.push(e),
    });
  beforeAll(() => {
    seen.length = 0;
  });
  afterAll(() => {
    seen.length = 0;
  });

  it("posts with the internal key and the sandbox token, and parses the key", async () => {
    const out = await client(respond(200, { kind: "api_key", api_key: KEY })).fetchGrant(
      "tok",
      "c1",
    );
    expect(out).toEqual({ ok: true, value: { kind: "api_key", apiKey: KEY } });
    expect(seen.at(-1)?.path).toBe("/internal/v1/mcp/connectors/c1/grant");
    expect(seen.at(-1)?.headers.get("kobe-sandbox-token")).toBe("tok");
    expect(seen.at(-1)?.headers.get("authorization")).toBe(`Bearer ${"i".repeat(40)}`);
  });

  it("separates not connected from everything else, failing closed", async () => {
    expect(await client(respond(404, { code: "not_connected" })).fetchGrant("t", "c")).toEqual({
      ok: false,
      failure: "not_connected",
    });
    for (const [status, body] of [
      [404, { code: "connector_not_available" }],
      [401, { code: "sandbox_unauthorized" }],
      [503, { code: "unavailable" }],
      [200, { kind: "oauth" }],
      [200, { kind: "api_key", api_key: "" }],
    ] as const) {
      expect(await client(respond(status, body)).fetchGrant("t", "c")).toEqual({
        ok: false,
        failure: "unavailable",
      });
    }
    const failing = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    expect(await client(failing).fetchGrant("t", "c")).toEqual({
      ok: false,
      failure: "unavailable",
    });
  });
});
