import { describe, expect, it } from "vitest";
import {
  argPatternSchema,
  findJsonSafetyIssue,
  hasDuplicateKeys,
  matchGlob,
  matchesArgPattern,
  parseJsonStrict,
  resolveJsonPointer,
} from "./index.js";

describe("glob grammar", () => {
  it.each([
    ["bash", "bash", true],
    ["bash", "bash2", false],
    ["mcp__jira__*", "mcp__jira__create_issue", true],
    ["mcp__jira__*", "mcp__jiras__x", false],
    ["*", "", true],
    ["a*b*c", "a-x-b-y-c", true],
    ["a*b*c", "a-x-c", false],
    ["git ?tatus", "git status", true],
    ["?", "😀", true],
    ["\\*", "*", true],
    ["\\*", "x", false],
    ["a\\?", "a?", true],
    ["a\\\\", "a\\", true],
    ["Bash", "bash", false],
    ["*/etc/*", "cat /etc/passwd", true],
  ])("%j vs %j → %s", (glob, subject, expected) => {
    expect(matchGlob(glob, subject)).toBe(expected);
  });

  it("is linear on pathological patterns", () => {
    const started = performance.now();
    expect(matchGlob("*a*a*a*a*a*a*a*a*b", "a".repeat(5000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("rejects a trailing escape", () => {
    expect(matchGlob("abc\\", "abc")).toBe(false);
  });
});

describe("arg patterns", () => {
  const input = { command: "git status --short", flags: ["a", "b"], n: 12, "a/b": { "c~d": "x" } };

  it("resolves RFC 6901 pointers", () => {
    expect(resolveJsonPointer(input, "/flags/1")).toBe("b");
    expect(resolveJsonPointer(input, "/a~1b/c~0d")).toBe("x");
    expect(resolveJsonPointer(input, "/flags/01")).toBeUndefined();
    expect(resolveJsonPointer(input, "/missing")).toBeUndefined();
    expect(resolveJsonPointer(input, "/command/length")).toBeUndefined();
  });

  it.each([
    [{ "/command": "git status*" }, true],
    [{ "/command": "git push*" }, false],
    [{ "/n": "1?" }, true],
    [{ "/flags": '["a"*' }, true],
    [{ "/command": "git *", "/n": "99" }, false],
    [{ "/missing": "*" }, false],
  ])("%j → %s", (pattern, expected) => {
    expect(matchesArgPattern(argPatternSchema.parse(pattern), input)).toBe(expected);
  });

  it("validates pattern shape", () => {
    expect(argPatternSchema.safeParse({}).success).toBe(false);
    expect(argPatternSchema.safeParse({ "": "x" }).success).toBe(false);
    expect(argPatternSchema.safeParse({ "/a~2": "x" }).success).toBe(false);
  });
});

describe("JSON boundary safety", () => {
  it.each([
    ['{"a":1,"a":2}', true],
    ['{"a":{"b":1},"b":{"b":2}}', false],
    ['{"a":"\\"a\\":1,","a2":[{"x":1},{"x":2}]}', false],
    ['{"\\u0061":1,"a":2}', true],
    ['[{"a":1},{"a":1}]', false],
  ])("detects duplicate keys in %s → %s", (text, expected) => {
    expect(hasDuplicateKeys(text)).toBe(expected);
  });

  it("finds unsafe values", () => {
    expect(findJsonSafetyIssue({ a: ["x\u0000"] })).toBe("nul_character");
    expect(findJsonSafetyIssue(JSON.parse('{"__proto__":1}'))).toBe("proto_key");
    expect(findJsonSafetyIssue({ n: 2 ** 53 })).toBeUndefined();
    expect(findJsonSafetyIssue({ n: 2 ** 53 }, { rejectUnsafeIntegers: true })).toBe(
      "unsafe_integer",
    );
    expect(findJsonSafetyIssue({ n: 1e30 }, { rejectUnsafeIntegers: true })).toBe("unsafe_integer");
    expect(
      findJsonSafetyIssue({ n: 0.5, s: "ok" }, { rejectUnsafeIntegers: true }),
    ).toBeUndefined();
  });

  it("parses strictly", () => {
    expect(parseJsonStrict('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonStrict("{")).toEqual({ ok: false, issue: "invalid_json" });
    expect(parseJsonStrict('{"a":1,"a":1}')).toEqual({ ok: false, issue: "duplicate_key" });
    expect(parseJsonStrict('{"a":"\\u0000"}')).toEqual({ ok: false, issue: "nul_character" });
  });
});
