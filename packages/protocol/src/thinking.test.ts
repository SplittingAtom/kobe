import { describe, expect, it } from "vitest";
import {
  effectiveThinkingLevel,
  narrowThinkingPolicy,
  selectableThinkingLevels,
  teamThinkingProblem,
  thinkingControlFits,
  thinkingPolicyProblem,
  type ThinkingPolicy,
} from "./thinking.js";

const effort = (over: Partial<ThinkingPolicy> = {}): ThinkingPolicy => ({
  control: "reasoning_effort",
  allowed: true,
  default: "low",
  max: "medium",
  ...over,
});
const NONE: ThinkingPolicy = { control: "none", allowed: false, default: null, max: null };
const OFF: ThinkingPolicy = {
  control: "reasoning_effort",
  allowed: false,
  default: null,
  max: null,
};
const ALWAYS_ON: ThinkingPolicy = {
  control: "anthropic_effort",
  allowed: true,
  default: "low",
  max: "high",
};

describe("thinking policies (KOBE-260)", () => {
  it("accepts the valid shapes", () => {
    expect(thinkingPolicyProblem(NONE, false)).toBeUndefined();
    expect(thinkingPolicyProblem(OFF, true)).toBeUndefined();
    expect(thinkingPolicyProblem(effort(), true)).toBeUndefined();
    expect(thinkingPolicyProblem(effort({ default: "off" }), true)).toBeUndefined();
    expect(thinkingPolicyProblem(ALWAYS_ON, true)).toBeUndefined();
  });

  it("refuses inconsistent ones", () => {
    expect(thinkingPolicyProblem({ ...NONE, allowed: true }, true)).toMatch(/no thinking levels/);
    expect(thinkingPolicyProblem(effort(), false)).toMatch(/marked as reasoning/);
    expect(thinkingPolicyProblem({ ...OFF, max: "high" }, true)).toMatch(/only set when/);
    expect(thinkingPolicyProblem(effort({ max: null }), true)).toMatch(/default and a maximum/);
    expect(thinkingPolicyProblem(effort({ default: "off", max: "off" }), true)).toMatch(
      /above off/,
    );
    expect(thinkingPolicyProblem(effort({ default: "high" }), true)).toMatch(/above the maximum/);
    expect(thinkingPolicyProblem({ ...ALWAYS_ON, default: "off" }, true)).toMatch(/cannot turn/);
    expect(
      thinkingPolicyProblem(
        { control: "anthropic_effort", allowed: false, default: null, max: null },
        true,
      ),
    ).toMatch(/stays allowed/);
  });

  it("fits controls to provider kinds", () => {
    expect(thinkingControlFits("ollama", "reasoning_effort")).toBe(true);
    expect(thinkingControlFits("anthropic", "reasoning_effort")).toBe(false);
    expect(thinkingControlFits("gemini", "gemini_budget")).toBe(true);
    expect(thinkingControlFits("openai", "anthropic_budget")).toBe(false);
    expect(thinkingControlFits("unknown", "none")).toBe(true);
  });
});

describe("clamping (ac-2)", () => {
  it("uses the default, a member's choice up to the maximum, never above it", () => {
    expect(effectiveThinkingLevel(effort(), undefined)).toBe("low");
    expect(effectiveThinkingLevel(effort(), null)).toBe("low");
    expect(effectiveThinkingLevel(effort(), "off")).toBe("off");
    expect(effectiveThinkingLevel(effort(), "medium")).toBe("medium");
    expect(effectiveThinkingLevel(effort(), "high")).toBe("medium");
  });

  it("keeps thinking off when it is not allowed, and never below a control's lowest level", () => {
    expect(effectiveThinkingLevel(OFF, "high")).toBe("off");
    expect(effectiveThinkingLevel(ALWAYS_ON, "off")).toBe("low");
    expect(effectiveThinkingLevel(NONE, "high")).toBeUndefined();
  });

  it("offers the levels between the lowest and the maximum", () => {
    expect(selectableThinkingLevels(effort())).toEqual(["off", "low", "medium"]);
    expect(selectableThinkingLevels(ALWAYS_ON)).toEqual(["low", "medium", "high"]);
    expect(selectableThinkingLevels({ ...ALWAYS_ON, max: "low" })).toEqual([]);
    expect(selectableThinkingLevels(OFF)).toEqual([]);
    expect(selectableThinkingLevels(NONE)).toEqual([]);
  });
});

describe("team narrowing (ac-4)", () => {
  it("lowers the maximum and the default, never raises them", () => {
    expect(narrowThinkingPolicy(effort({ max: "high", default: "medium" }), "low")).toEqual(
      effort({ max: "low", default: "low" }),
    );
    expect(narrowThinkingPolicy(effort(), "high")).toEqual(effort());
    expect(narrowThinkingPolicy(effort(), null)).toEqual(effort());
    expect(narrowThinkingPolicy(effort(), "off")).toEqual(OFF);
    expect(narrowThinkingPolicy(OFF, "high")).toEqual(OFF);
    expect(narrowThinkingPolicy(ALWAYS_ON, "off")).toEqual({ ...ALWAYS_ON, max: "low" });
  });

  it("refuses a team maximum that would widen the site's", () => {
    expect(teamThinkingProblem(effort(), "high")).toMatch(/only lower/);
    expect(teamThinkingProblem(OFF, "low")).toMatch(/off for this model/);
    expect(teamThinkingProblem(NONE, "low")).toMatch(/no thinking control/);
    expect(teamThinkingProblem(ALWAYS_ON, "off")).toMatch(/cannot turn/);
    expect(teamThinkingProblem(effort(), "low")).toBeUndefined();
    expect(teamThinkingProblem(effort(), "off")).toBeUndefined();
    expect(teamThinkingProblem(OFF, "off")).toBeUndefined();
    expect(teamThinkingProblem(effort(), null)).toBeUndefined();
  });
});
