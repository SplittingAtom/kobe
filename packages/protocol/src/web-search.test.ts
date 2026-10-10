import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  decodeSandboxFrame,
  kobeToolsRequestSchema,
  kobeToolsResponseSchema,
  webSearchInputSchema,
  WEB_SEARCH_UNAVAILABLE_MESSAGES,
} from "./index.js";

const ids = {
  request_id: "r1",
  run_id: "11111111-1111-4111-8111-111111111111",
  thread_id: "22222222-2222-4222-8222-222222222222",
  tool_call_id: "call-1",
};

describe("web_search contract", () => {
  it("is a read tool the server registry knows", () => {
    expect(BUILTIN_TOOLS.web_search).toMatchObject({ source: "kobe", risk: "read" });
  });

  it("validates the model input strictly", () => {
    // Kept as sent: the policy check hashed these exact bytes (no trim, or input_mismatch).
    expect(webSearchInputSchema.safeParse({ query: " cats ", count: 3 }).data).toEqual({
      query: " cats ",
      count: 3,
    });
    for (const bad of [
      {},
      { query: "" },
      { query: "   " },
      { query: "x", count: 11 },
      { query: "x", extra: 1 },
    ]) {
      expect(webSearchInputSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("accepts the query frame and the three result shapes", () => {
    const query = {
      v: 1,
      type: "web_search.query",
      ...ids,
      tool: "web_search",
      input: { query: "q" },
    };
    expect(decodeSandboxFrame(JSON.stringify(query)).ok).toBe(true);
    const ok = {
      ok: true,
      available: true,
      provider: "brave",
      query: "q",
      results: [{ title: "T", url: "https://example.com/a", snippet: "s" }],
    };
    const unavailable = {
      ok: true,
      available: false,
      reason: "team_not_enabled",
      message: WEB_SEARCH_UNAVAILABLE_MESSAGES.team_not_enabled,
    };
    const fail = { ok: false, error: { code: "search_failed", message: "x" } };
    for (const body of [ok, unavailable, fail]) {
      expect(kobeToolsResponseSchema.safeParse({ id: "k1", ...body }).success).toBe(true);
    }
  });

  it("rejects a citation without an http(s) url", () => {
    const bad = {
      id: "k1",
      ok: true,
      available: true,
      provider: "exa",
      query: "q",
      results: [{ title: "T", url: "javascript:alert(1)", snippet: "" }],
    };
    expect(kobeToolsResponseSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts the fd-4 request", () => {
    const req = {
      id: "k1",
      op: "web_search",
      tool_call_id: "c",
      tool: "web_search",
      input: { query: "q" },
    };
    expect(kobeToolsRequestSchema.safeParse(req).success).toBe(true);
  });
});
