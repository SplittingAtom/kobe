import { describe, expect, it } from "vitest";
import { parseToolsSnapshot } from "./snapshot.js";

const tool = {
  name: "create_issue",
  pi_name: "mcp__jira__create_issue",
  description: "Create an issue",
  input_schema: { type: "object", properties: { title: { type: "string" } } },
  annotations: { destructiveHint: false },
  sha256: "a".repeat(64),
  status: "pinned",
};

describe("parseToolsSnapshot", () => {
  it("keeps tools that parse and fills defaults", () => {
    const [parsed] = parseToolsSnapshot([
      { ...tool, description: undefined, annotations: undefined },
    ]);
    expect(parsed).toMatchObject({ name: "create_issue", description: "", annotations: {} });
  });

  it("drops entries that do not parse (fail closed), keeping the rest", () => {
    const tools = parseToolsSnapshot([
      tool,
      { ...tool, name: "has space" },
      { ...tool, pi_name: "create_issue" },
      { ...tool, sha256: "nothex" },
      { ...tool, status: "approved" },
      { ...tool, input_schema: "not an object" },
      null,
      "junk",
    ]);
    expect(tools.map((t) => t.name)).toEqual(["create_issue"]);
  });

  it("returns nothing for a snapshot that is not an array", () => {
    expect(parseToolsSnapshot({ tools: [tool] })).toEqual([]);
    expect(parseToolsSnapshot(null)).toEqual([]);
  });

  it("drops unknown annotation keys instead of passing them on", () => {
    const [parsed] = parseToolsSnapshot([{ ...tool, annotations: { readOnlyHint: true, x: 1 } }]);
    expect(parsed?.annotations).toEqual({ readOnlyHint: true });
  });
});
