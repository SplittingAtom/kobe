import { describe, expect, it } from "vitest";
import { buildSnapshot, snapshotHash, toolHash } from "./pin.js";

const tool = {
  name: "create_issue",
  description: "Create an issue",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" }, labels: { type: "array", items: { type: "string" } } },
    required: ["title"],
  },
};

describe("toolHash", () => {
  it("is a SHA-256 hex digest", () => {
    expect(toolHash(tool)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across key order, at any depth", () => {
    const reordered = {
      inputSchema: {
        required: ["title"],
        properties: {
          labels: { items: { type: "string" }, type: "array" },
          title: { type: "string" },
        },
        type: "object",
      },
      description: tool.description,
      name: tool.name,
    };
    expect(toolHash(reordered)).toBe(toolHash(tool));
  });

  it("is stable across JSON whitespace (parse of differently formatted text)", () => {
    const pretty = JSON.parse(JSON.stringify(tool, null, 4)) as typeof tool;
    const spaced = JSON.parse(
      `  ${JSON.stringify(tool).replaceAll(",", " ,\n\t")}  `,
    ) as typeof tool;
    expect(toolHash(pretty)).toBe(toolHash(tool));
    expect(toolHash(spaced)).toBe(toolHash(tool));
  });

  it("ignores fields outside name, description and input schema", () => {
    const extra = { ...tool, title: "x", annotations: { readOnlyHint: true } };
    expect(toolHash(extra)).toBe(toolHash(tool));
  });

  it("treats a missing description as empty", () => {
    const { description: _unused, ...bare } = tool;
    expect(toolHash(bare)).toBe(toolHash({ ...tool, description: "" }));
  });

  it("changes when the name, description or input schema changes", () => {
    const base = toolHash(tool);
    expect(toolHash({ ...tool, name: "create_issues" })).not.toBe(base);
    expect(toolHash({ ...tool, description: "Create an issue. Also email it." })).not.toBe(base);
    expect(toolHash({ ...tool, description: "Create an issue " })).not.toBe(base);
    expect(
      toolHash({ ...tool, inputSchema: { ...tool.inputSchema, required: ["title", "body"] } }),
    ).not.toBe(base);
  });

  it("does not confuse fields (a value moved between name and description)", () => {
    expect(toolHash({ name: "a", description: "b", inputSchema: {} })).not.toBe(
      toolHash({ name: "b", description: "a", inputSchema: {} }),
    );
  });
});

describe("buildSnapshot", () => {
  it("pins every tool with its Pi name, hash and status", () => {
    const result = buildSnapshot("my-jira", [
      { ...tool, title: "Create", annotations: { readOnlyHint: false, junk: 1 } },
      { name: "get.issue", inputSchema: { type: "object" } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tools.map((t) => [t.name, t.pi_name, t.status])).toEqual([
      ["create_issue", "mcp__my_jira__create_issue", "pinned"],
      ["get.issue", "mcp__my_jira__get_issue", "pinned"],
    ]);
    expect(result.tools[0]).toMatchObject({
      sha256: toolHash(tool),
      title: "Create",
      description: "Create an issue",
      annotations: { readOnlyHint: false },
    });
    expect(result.tools[1]?.description).toBe("");
    expect(result.hash).toBe(snapshotHash(result.tools));
  });

  it("snapshot hash ignores tool order but not content", () => {
    const a = buildSnapshot("s", [tool, { name: "b", inputSchema: {} }]);
    const b = buildSnapshot("s", [{ name: "b", inputSchema: {} }, tool]);
    const c = buildSnapshot("s", [tool, { name: "b", description: "x", inputSchema: {} }]);
    if (!a.ok || !b.ok || !c.ok) throw new Error("expected pins");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it("pins an empty tool list", () => {
    expect(buildSnapshot("s", [])).toMatchObject({ ok: true, tools: [] });
  });

  it("refuses a snapshot with malformed tools", () => {
    expect(buildSnapshot("s", [{ name: "has space", inputSchema: {} }])).toEqual({
      ok: false,
      failure: "invalid_tool",
    });
    expect(buildSnapshot("s", [{ name: "x", inputSchema: "nope" }])).toMatchObject({ ok: false });
    expect(buildSnapshot("s", ["junk"])).toMatchObject({ ok: false });
  });

  it("refuses names that collide as Pi names or repeat (nothing is pinned)", () => {
    const schema = { type: "object" };
    expect(
      buildSnapshot("s", [
        { name: "get-x", inputSchema: schema },
        { name: "get_x", inputSchema: schema },
      ]),
    ).toEqual({ ok: false, failure: "ambiguous_tool_names" });
    expect(
      buildSnapshot("s", [
        { name: "x", inputSchema: schema },
        { name: "x", inputSchema: schema },
      ]),
    ).toEqual({ ok: false, failure: "ambiguous_tool_names" });
  });
});
