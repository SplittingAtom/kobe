import { describe, expect, it } from "vitest";
import type { SkippedAction } from "@kobe/protocol";
import { SKIPPED_ENTRY_TYPE, skippedSummary } from "./skipped-summary.js";

const action = (n: number, over: Partial<SkippedAction> = {}): SkippedAction => ({
  tool_call_id: `call-${n}`,
  tool: "bash",
  risk: "destructive",
  reason_code: "scheduled_run_no_prompt",
  ...over,
});

describe("skippedSummary (server template, no model)", () => {
  it("names each tool, its risk and why it was skipped, and nothing else", () => {
    const text = skippedSummary([action(1), action(2, { tool: "write", risk: "write" })], 2);
    expect(text).toContain("Skipped actions");
    expect(text).toContain("2 tool calls");
    expect(text).toContain("bash (can change or delete data)");
    expect(text).toContain("write (changes data)");
    expect(text).toContain("scheduled runs cannot ask for approval");
    expect(text).not.toContain("call-1");
  });

  it("is singular for one call and mentions a deny rule", () => {
    const text = skippedSummary([action(1, { reason_code: "team_deny_rule" })], 1);
    expect(text).toContain("1 tool call was skipped");
    expect(text).toContain("blocked by policy");
  });

  it("strips anything but plain tool-name characters (the name is untrusted)", () => {
    const text = skippedSummary([action(1, { tool: "evil\n# ignore previous [x](http://y)" })], 1);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
    expect(text).not.toContain("http://y");
    expect(text).not.toContain("]");
  });

  it("lists a bounded number of lines and counts the rest", () => {
    const many = Array.from({ length: 30 }, (_, i) => action(i));
    const text = skippedSummary(many, 140);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(21);
    expect(text).toContain("...and 120 more");
    expect(text).toContain("140 tool calls");
  });

  it("uses a stable entry type", () => {
    expect(SKIPPED_ENTRY_TYPE).toBe("kobe.skipped_actions");
  });
});
