import { describe, expect, it } from "vitest";
import { knownThinkingLowest, knownThinkingProblem } from "./thinking-models.js";
import {
  effectiveThinkingLevel,
  strictestThinkingPolicy,
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
  lowest: "off",
  ...over,
});
const NONE: ThinkingPolicy = {
  control: "none",
  allowed: false,
  default: null,
  max: null,
  lowest: "off",
};
const OFF: ThinkingPolicy = {
  control: "reasoning_effort",
  allowed: false,
  default: null,
  max: null,
  lowest: "off",
};
const ALWAYS_ON: ThinkingPolicy = {
  control: "anthropic_effort",
  allowed: true,
  default: "low",
  max: "high",
  lowest: "low",
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
        { control: "anthropic_effort", allowed: false, default: null, max: null, lowest: "low" },
        true,
      ),
    ).toMatch(/stays allowed/);
    // anthropic_effort has no off at all; a model marked "cannot turn off" keeps thinking on.
    expect(thinkingPolicyProblem({ ...ALWAYS_ON, lowest: "off" }, true)).toMatch(/lowest level/);
    expect(thinkingPolicyProblem({ ...OFF, lowest: "low" }, true)).toMatch(/stays allowed/);
    expect(thinkingPolicyProblem(effort({ lowest: "low", default: "off" }), true)).toMatch(
      /at least low/,
    );
    expect(thinkingPolicyProblem({ ...NONE, lowest: "low" }, true)).toMatch(/no thinking levels/);
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

  it("never sends off to a model that cannot turn thinking off (review S2)", () => {
    const o3 = effort({ lowest: "low", default: "low", max: "high" });
    expect(effectiveThinkingLevel(o3, "off")).toBe("low");
    expect(selectableThinkingLevels(o3)).toEqual(["low", "medium", "high"]);
    // A team's "off" is the lowest level too.
    expect(narrowThinkingPolicy(o3, "off")).toEqual({ ...o3, max: "low" });
    expect(teamThinkingProblem(o3, "off")).toMatch(/cannot turn/);
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

describe("strictest policy of one model (review N1)", () => {
  it("keeps the lowest ceiling; off beats any level; a control beats none", () => {
    expect(strictestThinkingPolicy([effort({ max: "high" }), effort()])).toEqual(effort());
    expect(strictestThinkingPolicy([effort(), OFF])).toEqual(OFF);
    expect(strictestThinkingPolicy([NONE, effort()])).toEqual(effort());
    expect(strictestThinkingPolicy([])).toBeUndefined();
  });
});

describe("known model families (review S2)", () => {
  it("knows which cannot turn thinking off", () => {
    for (const m of [
      "o3",
      "o4-mini",
      "gpt-5",
      "openai/gpt-5-mini",
      "gpt-5-pro",
      "gemini-2.5-pro",
    ]) {
      expect(knownThinkingLowest(m), m).toBe("low");
    }
    for (const m of [
      "gemini-3-pro-preview",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
    ]) {
      expect(knownThinkingLowest(m), m).toBe("low");
    }
    for (const m of [
      "gpt-5.1",
      "gpt-5.2",
      "gemini-2.5-flash",
      "glm-5.3",
      "claude-opus-4-6",
      "qwen3",
    ]) {
      expect(knownThinkingLowest(m), m).toBeUndefined();
    }
  });

  it("refuses off for them and budgets for Claude models that reject budget_tokens", () => {
    expect(knownThinkingProblem("o3", effort())).toMatch(/cannot turn thinking off/);
    expect(knownThinkingProblem("o3", effort({ lowest: "low", default: "low" }))).toBeUndefined();
    const budget = effort({ control: "anthropic_budget" });
    expect(knownThinkingProblem("claude-opus-4-8", budget)).toMatch(/refuses thinking budgets/);
    expect(knownThinkingProblem("claude-haiku-4-5", budget)).toBeUndefined();
    expect(knownThinkingProblem("o3", NONE)).toBeUndefined();
  });
});
