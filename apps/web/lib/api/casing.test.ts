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
