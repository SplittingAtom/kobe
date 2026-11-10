import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  builtinToolDescriptor,
  decodeSandboxFrame,
  decodeServerFrame,
  kobeToolsRequestSchema,
  LEGACY_WEB_SEARCH_MESSAGE,
} from "./index.js";

// KOBE-606: the built-in web search is gone; only old agents' frames are still understood.
describe("retired web_search", () => {
  it("is no longer a built-in tool or a kobe-tools op", () => {
    expect(Object.keys(BUILTIN_TOOLS)).not.toContain("web_search");
    expect(builtinToolDescriptor("web_search")).toBeUndefined();
    const req = { id: "k1", op: "web_search", tool_call_id: "c", tool: "web_search", input: {} };
    expect(kobeToolsRequestSchema.safeParse(req).success).toBe(false);
  });

  it("still decodes an old agent's query frame, whatever its input", () => {
    const query = {
      v: 1,
      type: "web_search.query",
      request_id: "r1",
      run_id: "11111111-1111-4111-8111-111111111111",
      thread_id: "22222222-2222-4222-8222-222222222222",
      tool_call_id: "call-1",
      tool: "web_search",
      input: { query: "q", count: 99 },
    };
    expect(decodeSandboxFrame(JSON.stringify(query)).ok).toBe(true);
  });

  it("answers only unavailable, in the shape old agents accept", () => {
    const answer = (body: object) =>
      decodeServerFrame(
        JSON.stringify({ v: 1, type: "web_search.result", request_id: "r1", ...body }),
      );
    const unavailable = { ok: true, available: false, reason: "not_configured" };
    expect(answer({ ...unavailable, message: LEGACY_WEB_SEARCH_MESSAGE }).ok).toBe(true);
    expect(
      answer({ ok: true, available: true, provider: "brave", query: "q", results: [] }).ok,
    ).toBe(false);
  });
});
