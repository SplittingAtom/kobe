import { CAPABILITY_WEB_SEARCH, WEB_SEARCH_QUERY_MAX } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import type { ToolsOutcome } from "./client.js";
import { registerKobeTools } from "./extension.js";
import {
  OP_WEB_SEARCH,
  OPS,
  TOOL_WEB_SEARCH,
  WEB_SEARCH_QUERY_MAX as QUERY_MAX,
} from "./protocol.js";
import { ToolFailure, webSearchTool, type ToolDefinitionLike } from "./tools.js";

const calls: unknown[] = [];
const transport = (outcome: ToolsOutcome) => ({
  request: (call: unknown) => {
    calls.push(call);
    return Promise.resolve(outcome);
  },
});

describe("web_search tool", () => {
  it("mirrors the protocol constants", () => {
    expect(TOOL_WEB_SEARCH).toBe("web_search");
    expect(OPS).toContain(OP_WEB_SEARCH);
    expect(QUERY_MAX).toBe(WEB_SEARCH_QUERY_MAX);
    expect(CAPABILITY_WEB_SEARCH).toBe("web_search");
  });

  it("sends the query and returns numbered citations with URLs", async () => {
    const tool = webSearchTool(
      transport({
        ok: true,
        available: true,
        provider: "brave",
        query: "kobe",
        results: [{ title: "Kobe", url: "https://example.com/k", snippet: "About Kobe" }],
      }),
    );
    const result = await tool.execute("call-1", { query: "kobe", count: 3 });
    expect(calls.at(-1)).toMatchObject({
      op: "web_search",
      tool_call_id: "call-1",
      tool: "web_search",
      input: { query: "kobe", count: 3 },
    });
    expect(result.content[0]?.text).toContain("1. Kobe");
    expect(result.content[0]?.text).toContain("https://example.com/k");
    expect(result.content[0]?.text).toContain("About Kobe");
    expect(result.details).toMatchObject({ available: true, provider: "brave" });
  });

  it("returns the unavailable message as a normal result, not an error", async () => {
    const tool = webSearchTool(
      transport({
        ok: true,
        available: false,
        reason: "team_not_enabled",
        message: "Web search is unavailable: your team has not turned it on.",
      }),
    );
    const result = await tool.execute("c", { query: "x" });
    expect(result.content[0]?.text).toContain("Web search is unavailable");
    expect(result.details).toMatchObject({ available: false, reason: "team_not_enabled" });
  });

  it("turns a server error into a tool failure", async () => {
    const tool = webSearchTool(
      transport({ ok: false, error: { code: "search_failed", message: "provider down" } }),
    );
    await expect(tool.execute("c", { query: "x" })).rejects.toThrow(ToolFailure);
  });

  it.each([
    {},
    { query: "" },
    { query: "x".repeat(QUERY_MAX + 1) },
    { query: "x", count: 0 },
    { query: "x", n: 1 },
  ])("refuses invalid input %j before sending", async (input) => {
    const before = calls.length;
    await expect(
      webSearchTool(
        transport({ ok: true, available: false, reason: "not_configured", message: "m" }),
      ).execute("c", input),
    ).rejects.toThrow(ToolFailure);
    expect(calls.length).toBe(before);
  });

  it("is registered next to the other tools", () => {
    const names: string[] = [];
    registerKobeTools(
      { registerTool: (t: ToolDefinitionLike) => names.push(t.name) },
      transport({ ok: false, error: { code: "x", message: "y" } }),
    );
    expect(names).toContain("web_search");
  });
});
