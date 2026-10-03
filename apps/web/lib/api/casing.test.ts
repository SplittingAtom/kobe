import { describe, expect, it } from "vitest";
import { camelizeKeys, toCamel } from "./casing";

describe("toCamel", () => {
  it.each([
    ["owner_user_id", "ownerUserId"],
    ["ownerUserId", "ownerUserId"],
    ["id", "id"],
    ["leaf_entry_id", "leafEntryId"],
    ["_private", "_private"],
    ["a__b", "a__b"],
  ])("%s → %s", (input, expected) => {
    expect(toCamel(input)).toBe(expected);
  });
});

describe("camelizeKeys", () => {
  it("converts snake_case keys deeply and leaves camelCase alone", () => {
    expect(
      camelizeKeys({
        thread_id: "t",
        agentVersion: 3,
        entries: [{ entry_id: "e", parent_id: null }],
      }),
    ).toEqual({ threadId: "t", agentVersion: 3, entries: [{ entryId: "e", parentId: null }] });
  });

  it("never touches values, only keys", () => {
    expect(camelizeKeys({ role: "team_admin", list: ["a_b"] })).toEqual({
      role: "team_admin",
      list: ["a_b"],
    });
  });

  it("keeps an approval's tool input exactly as it will run (KOBE-37)", () => {
    const input = { issue_type: "Bug", nested_key: { a_b: 1 } };
    expect(camelizeKeys({ approval_id: "a", input })).toEqual({ approvalId: "a", input });
  });

  it("keeps opaque documents (agent frontmatter) exactly as the server sent them", () => {
    const frontmatter = { approval_mode: "ask-all", tools: { allow: ["x"] } };
    expect(camelizeKeys({ agent: { current_version: 1, frontmatter } })).toEqual({
      agent: { currentVersion: 1, frontmatter },
    });
  });

  it("keeps policy arg patterns (JSON-pointer keys) exactly as sent", () => {
    const pattern = { "/file_path": "/workspace/**", "/opts/dry_run": "true" };
    expect(camelizeKeys({ rules: [{ tool_glob: "write", arg_pattern: pattern }] })).toEqual({
      rules: [{ toolGlob: "write", argPattern: pattern }],
    });
  });

  it("keeps Pi entry payloads verbatim (tool-call arguments must not be renamed)", () => {
    const payload = {
      type: "message",
      parentId: "a1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", arguments: { file_path: "/x" } }],
      },
    };
    expect(camelizeKeys({ entries: [{ entry_id: "e1", payload }] })).toEqual({
      entries: [{ entryId: "e1", payload }],
    });
  });

  it("does not let a key named __proto__ reach the prototype", () => {
    const out = camelizeKeys(JSON.parse('{"__proto__": {"polluted": true}, "a_b": 1}')) as Record<
      string,
      unknown
    >;
    expect(out.aB).toBe(1);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
