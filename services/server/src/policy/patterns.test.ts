import { describe, expect, it } from "vitest";
import { builtin, mcpTool } from "../testing/policy-fixtures.js";
import {
  MAX_GLOB_SUBJECT_LENGTH,
  matchAgentToolEntry,
  matchArgPattern,
  matchSubject,
  splitAgentToolEntry,
} from "./patterns.js";

describe("matchArgPattern (JSON Pointer → glob)", () => {
  const input = {
    command: "git push origin main",
    path: "/workspace/report.md",
    count: 12,
    flags: ["a", "b"],
    nested: { "a/b": { "c~d": "deep" } },
    empty: "",
    nothing: null,
  };

  it.each([
    [{ "/command": "git push*" }, true],
    [{ "/command": "git push" }, false], // anchored
    [{ "/command": "*push*", "/path": "/workspace/*" }, true], // every entry must match
    [{ "/command": "*push*", "/path": "/tmp/*" }, false],
    [{ "/count": "1?" }, true], // non-strings match their canonical JSON
    [{ "/count": "12" }, true],
    [{ "/flags": '["a"*' }, true],
    [{ "/flags/1": "b" }, true], // array index
    [{ "/flags/01": "b" }, false], // non-canonical index never resolves
    [{ "/flags/2": "*" }, false], // out of range
    [{ "/flags/-": "*" }, false],
    [{ "/nested/a~1b/c~0d": "deep" }, true], // ~1 = "/", ~0 = "~"
    [{ "/nested/a/b": "*" }, false],
    [{ "/empty": "" }, false], // the glob grammar has no empty pattern; "" is never valid
    [{ "/empty": "*" }, true],
    [{ "/nothing": "null" }, true],
    [{ "/missing": "*" }, false], // unresolvable pointer never matches
  ] as const)("%j → %s", (pattern, expected) => {
    expect(matchArgPattern(pattern, input, "loosen")).toBe(expected);
  });

  it("never matches an unresolvable pointer, even for restricting rules", () => {
    expect(matchArgPattern({ "/missing": "*" }, input, "restrict")).toBe(false);
  });

  it("does not resolve inherited properties", () => {
    expect(matchArgPattern({ "/constructor": "*" }, {}, "restrict")).toBe(false);
    expect(matchArgPattern({ "/toString": "*" }, { a: "x" }, "loosen")).toBe(false);
  });

  it("matches by code point, without Unicode normalisation", () => {
    expect(matchArgPattern({ "/s": "?" }, { s: "😀" }, "loosen")).toBe(true); // one code point
    expect(matchArgPattern({ "/s": "??" }, { s: "😀" }, "loosen")).toBe(false);
    // NFC "é" vs NFD "e" + U+0301 are different subjects.
    expect(matchArgPattern({ "/s": "café" }, { s: "café" }, "loosen")).toBe(false);
    expect(matchArgPattern({ "/s": "caf?" }, { s: "café" }, "loosen")).toBe(false);
    expect(matchArgPattern({ "/s": "caf*" }, { s: "café" }, "loosen")).toBe(true);
    // Keys are matched exactly, including non-ASCII.
    expect(matchArgPattern({ "/ключ": "знач*" }, { ключ: "значение" }, "loosen")).toBe(true);
  });

  it("treats glob metacharacters literally when escaped", () => {
    expect(matchArgPattern({ "/s": "a\\*b" }, { s: "a*b" }, "loosen")).toBe(true);
    expect(matchArgPattern({ "/s": "a\\*b" }, { s: "axb" }, "loosen")).toBe(false);
    expect(matchArgPattern({ "/s": "\\?" }, { s: "?" }, "loosen")).toBe(true);
    expect(matchArgPattern({ "/s": "\\\\" }, { s: "\\" }, "loosen")).toBe(true);
    // Regex syntax means nothing.
    expect(matchArgPattern({ "/s": "a.+" }, { s: "abc" }, "loosen")).toBe(false);
    expect(matchArgPattern({ "/s": "[a-z]" }, { s: "q" }, "loosen")).toBe(false);
  });
});

describe("matchSubject: adversarial inputs fail closed and stay fast", () => {
  const evil = `${"*a".repeat(127)}*b`; // 255 code points: the classic backtracking killer

  it("handles the worst-case pattern at the subject cap quickly", () => {
    const subject = "a".repeat(MAX_GLOB_SUBJECT_LENGTH);
    const start = performance.now();
    expect(matchSubject(evil, subject, "loosen")).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("over-long subjects: restricting rules match, loosening rules don't", () => {
    const subject = "a".repeat(MAX_GLOB_SUBJECT_LENGTH + 1);
    const start = performance.now();
    expect(matchSubject(evil, subject, "restrict")).toBe(true);
    expect(matchSubject("*", subject, "loosen")).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it("over-long values inside the input follow the same rule", () => {
    const input = { command: `echo ${"x".repeat(MAX_GLOB_SUBJECT_LENGTH)}` };
    expect(matchArgPattern({ "/command": "rm*" }, input, "restrict")).toBe(true);
    expect(matchArgPattern({ "/command": "echo*" }, input, "loosen")).toBe(false);
  });

  it("malformed globs: restricting rules match, loosening rules don't", () => {
    expect(matchSubject("abc\\", "abc", "restrict")).toBe(true);
    expect(matchSubject("abc\\", "abc", "loosen")).toBe(false);
    expect(matchSubject("", "", "loosen")).toBe(false);
  });

  it("a lone surrogate subject is just code units, never a crash", () => {
    expect(matchSubject("?", "\ud800", "loosen")).toBe(true);
  });
});

describe("agent tools.allow / tools.deny entries", () => {
  it.each([
    ["bash:rm -rf*", "bash", "rm -rf*"],
    ["bash", "bash", undefined],
    ["a\\:b:c", "a\\:b", "c"], // escaped colon stays in the tool part
    ["bash:", "bash", ""],
    [":x", "", "x"],
  ] as const)("splits %j", (entry, tool, arg) => {
    expect(splitAgentToolEntry(entry)).toEqual({ tool, arg });
  });

  const bash = builtin("bash");
  it("matches the primary argument of built-ins", () => {
    expect(matchAgentToolEntry("bash:rm -rf*", bash, { command: "rm -rf /" }, "restrict")).toBe(
      true,
    );
    expect(matchAgentToolEntry("bash:rm -rf*", bash, { command: "ls" }, "restrict")).toBe(false);
    expect(matchAgentToolEntry("ba*", bash, {}, "loosen")).toBe(true);
    expect(matchAgentToolEntry("read", bash, {}, "restrict")).toBe(false);
  });

  it("a missing primary argument never matches", () => {
    expect(matchAgentToolEntry("bash:*", bash, {}, "restrict")).toBe(false);
  });

  it("an empty tool part fails closed", () => {
    expect(matchAgentToolEntry(":x", bash, {}, "restrict")).toBe(true);
    expect(matchAgentToolEntry(":x", bash, {}, "loosen")).toBe(false);
  });

  it("an MCP tool has no primary argument: deny falls back to the name, allow doesn't match", () => {
    const tool = mcpTool("mcp__fs__delete", "destructive");
    expect(matchAgentToolEntry("mcp__fs__*:/etc*", tool, { path: "/tmp" }, "restrict")).toBe(true);
    expect(matchAgentToolEntry("mcp__fs__*:/tmp*", tool, { path: "/tmp" }, "loosen")).toBe(false);
  });
});
