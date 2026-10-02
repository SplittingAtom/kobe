import { describe, expect, it } from "vitest";
import { allowGlobScoped, literalPrefix } from "./patterns.js";
import { rememberGlobAllowed } from "./remember.js";
import { toPolicyRule } from "./rule-store.js";

describe("rememberGlobAllowed (approve and remember stays with the approved tool)", () => {
  it.each([
    ["bash", "bash", true],
    ["bash*", "bash", false], // built-ins: exact name only
    ["*", "bash", false],
    ["read", "bash", false], // must match the approved tool
    ["mcp__jira__create_issue", "mcp__jira__create_issue", true],
    ["mcp__jira__*", "mcp__jira__create_issue", true], // siblings of the same connector
    ["mcp__jira__create_*", "mcp__jira__create_issue", true],
    ["mcp__jira_*", "mcp__jira__create_issue", false], // could reach mcp__jira_x__…
    ["mcp__*", "mcp__jira__create_issue", false], // other connectors
    ["*__create_issue", "mcp__jira__create_issue", false],
    ["mcp__jira\\_\\_*", "mcp__jira__create_issue", true], // escapes count as literals
    ["mcp__jira__?reate_issue", "mcp__jira__create_issue", true],
    ["mcp__jira__x", "not_a_tool", false],
  ] as const)("%j for %s → %s", (glob, tool, expected) => {
    expect(rememberGlobAllowed(glob, tool)).toBe(expected);
  });

  it("computes literal prefixes", () => {
    expect(literalPrefix("abc*def")).toBe("abc");
    expect(literalPrefix("a\\*b?c")).toBe("a*b");
    expect(literalPrefix("*")).toBe("");
  });
});

describe("allowGlobScoped (no blanket allow rules)", () => {
  it.each([
    ["bash", true],
    ["read", true],
    ["mcp__jira__create_issue", true],
    ["mcp__jira__*", true],
    ["mcp__my_server__?", true],
    ["*", false],
    ["b*", false],
    ["bash*", false],
    ["mcp__*", false],
    ["mcp__jira_*", false],
    ["mcp__jira*__x", false],
    ["mcp__JIRA__x", false],
    ["mcp____x", false],
    ["*__create_issue", false],
    ["toString", false],
    ["__proto__", false],
  ] as const)("%j → %s", (glob, expected) => {
    expect(allowGlobScoped(glob)).toBe(expected);
  });
});

describe("toPolicyRule (stored rows fail closed)", () => {
  const base = { id: "00000000-0000-4000-8000-000000000001", argPattern: null, expiresAt: null };

  it("keeps valid rows as they are", () => {
    expect(
      toPolicyRule(
        { ...base, effect: "allow", toolGlob: "read", argPattern: { "/path": "/workspace/*" } },
        "user",
      ),
    ).toEqual({
      id: base.id,
      scope: "user",
      effect: "allow",
      tool_glob: "read",
      arg_pattern: { "/path": "/workspace/*" },
    });
  });

  it("drops an allow rule that isn't scoped to one tool or connector", () => {
    expect(toPolicyRule({ ...base, effect: "allow", toolGlob: "*" }, "team")).toBeUndefined();
    expect(toPolicyRule({ ...base, effect: "deny", toolGlob: "*" }, "team")).toBeDefined();
  });

  it("drops an unreadable allow rule", () => {
    expect(toPolicyRule({ ...base, effect: "allow", toolGlob: "bad\\" }, "user")).toBeUndefined();
    expect(
      toPolicyRule({ ...base, effect: "allow", toolGlob: "read", argPattern: { x: "y" } }, "team"),
    ).toBeUndefined();
  });

  it("widens an unreadable deny/ask rule instead of dropping it", () => {
    expect(toPolicyRule({ ...base, effect: "deny", toolGlob: "bad\\" }, "install")).toMatchObject({
      tool_glob: "*",
    });
    const ask = toPolicyRule(
      { ...base, effect: "ask", toolGlob: "bash", argPattern: { nope: "x" } },
      "team",
    );
    expect(ask).toMatchObject({ tool_glob: "bash" });
    expect(ask).not.toHaveProperty("arg_pattern");
  });

  it("carries the expiry", () => {
    expect(
      toPolicyRule(
        { ...base, effect: "deny", toolGlob: "x", expiresAt: new Date("2027-01-01T00:00:00Z") },
        "install",
      ),
    ).toMatchObject({ expires_at: "2027-01-01T00:00:00.000Z" });
  });
});
