import { describe, expect, it } from "vitest";
import {
  approveAllBodySchema,
  CLOSED_REMEMBER_LIMITS,
  DEFAULT_REMEMBER_LIMITS,
  looserThanFloor,
  rememberLimitsSchema,
  rememberRuleSchema,
  REMEMBER_SCOPES,
  scopeWithinLimits,
  tightenRememberLimits,
  type RememberLimits,
} from "./remember.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

const limits = (over: Partial<RememberLimits>): RememberLimits => ({
  ...DEFAULT_REMEMBER_LIMITS,
  ...over,
});

describe("remember rules (KOBE-289)", () => {
  it("takes a tool, a scope and an exact flag only", () => {
    expect(rememberRuleSchema.parse({ tool_glob: "bash", scope: "thread" })).toEqual({
      tool_glob: "bash",
      scope: "thread",
      exact: false,
    });
    for (const bad of [
      { tool_glob: "bash" },
      { tool_glob: "bash", scope: "week" },
      { tool_glob: "bash", scope: "day", expires_in: 60 },
      { tool_glob: "bash", scope: "day", arg_pattern: { "/command": "*" } },
    ]) {
      expect(rememberRuleSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("approve-all lists 2 to 100 distinct approvals of one run", () => {
    expect(approveAllBodySchema.safeParse({ run_id: U1, approval_ids: [U1, U2] }).success).toBe(
      true,
    );
    expect(approveAllBodySchema.safeParse({ run_id: U1, approval_ids: [U1] }).success).toBe(false);
    expect(approveAllBodySchema.safeParse({ run_id: U1, approval_ids: [U1, U1] }).success).toBe(
      false,
    );
  });
});

describe("remember limits", () => {
  it("validates stored limits", () => {
    expect(rememberLimitsSchema.safeParse(DEFAULT_REMEMBER_LIMITS).success).toBe(true);
    expect(rememberLimitsSchema.safeParse(CLOSED_REMEMBER_LIMITS).success).toBe(true);
    expect(
      rememberLimitsSchema.safeParse({ ...DEFAULT_REMEMBER_LIMITS, scopes: ["day", "day"] })
        .success,
    ).toBe(false);
    expect(
      rememberLimitsSchema.safeParse({ ...DEFAULT_REMEMBER_LIMITS, max_duration_seconds: 0 })
        .success,
    ).toBe(false);
  });

  it("tightening takes the stricter value of every field", () => {
    const site = limits({
      scopes: ["thread", "run", "day", "forever"],
      max_duration_seconds: 7200,
    });
    const team = limits({
      scopes: ["thread", "today", "day"],
      max_duration_seconds: null,
      mcp_tools: false,
      exact_only: true,
      approve_all: false,
    });
    expect(tightenRememberLimits(site, team)).toEqual({
      scopes: ["thread", "day"],
      max_duration_seconds: 7200,
      mcp_tools: false,
      exact_only: true,
      approve_all: false,
    });
    // Order of arguments does not matter.
    expect(tightenRememberLimits(team, site)).toEqual(tightenRememberLimits(site, team));
  });

  it("a team can never loosen the floor", () => {
    const floor = limits({
      scopes: ["thread", "run"],
      max_duration_seconds: 3600,
      mcp_tools: false,
      exact_only: true,
      approve_all: false,
    });
    expect(looserThanFloor(DEFAULT_REMEMBER_LIMITS, floor)).toEqual([
      "scopes",
      "max_duration_seconds",
      "mcp_tools",
      "exact_only",
      "approve_all",
    ]);
    expect(looserThanFloor(floor, floor)).toEqual([]);
    expect(looserThanFloor(limits({ ...floor, max_duration_seconds: 60 }), floor)).toEqual([]);
  });

  it("offers fixed lifetimes only within the max duration, never 'until revoked' under one", () => {
    const max = limits({ max_duration_seconds: 2 * 24 * 3600 });
    expect(REMEMBER_SCOPES.filter((s) => scopeWithinLimits(s, max))).toEqual([
      "thread",
      "today",
      "run",
      "day",
    ]);
    expect(scopeWithinLimits("run", limits({ scopes: ["thread"] }))).toBe(false);
    expect(REMEMBER_SCOPES.every((s) => scopeWithinLimits(s, DEFAULT_REMEMBER_LIMITS))).toBe(true);
  });
});
