import { describe, expect, it } from "vitest";
import { MODEL_TOKEN_DEFAULTS, effectiveModelLimits, outputLimitProblem } from "./token-limits.js";

const defaults = {
  maxOutputTokens: 16_384,
  reasoningMaxOutputTokens: 32_768,
  contextWindow: 128_000,
};
const none = { maxOutputTokens: null, contextWindow: null, reasoning: false };

describe("model token limits (KOBE-259)", () => {
  it("defaults: the old output limit for other models, a higher one for reasoning models", () => {
    expect(MODEL_TOKEN_DEFAULTS).toEqual(defaults);
    expect(effectiveModelLimits(none, defaults)).toEqual({
      max_output_tokens: 16_384,
      context_window: 128_000,
    });
    expect(effectiveModelLimits({ ...none, reasoning: true }, defaults)).toEqual({
      max_output_tokens: 32_768,
      context_window: 128_000,
    });
  });

  it("the catalog's values win, the flag only picks a default", () => {
    expect(
      effectiveModelLimits(
        { maxOutputTokens: 8_000, contextWindow: 1_000_000, reasoning: true },
        defaults,
      ),
    ).toEqual({ max_output_tokens: 8_000, context_window: 1_000_000 });
  });

  it("a default output limit that would fill a smaller window becomes half the window", () => {
    expect(
      effectiveModelLimits({ ...none, reasoning: true, contextWindow: 32_768 }, defaults),
    ).toEqual({ max_output_tokens: 16_384, context_window: 32_768 });
    // A catalog limit set with the old default window, after the default window shrank.
    expect(
      effectiveModelLimits(
        { ...none, maxOutputTokens: 100_000 },
        { ...defaults, contextWindow: 64_000 },
      ),
    ).toEqual({ max_output_tokens: 32_000, context_window: 64_000 });
  });

  it("names the window an admin's output limit must stay below", () => {
    expect(outputLimitProblem(128_000, null, defaults)).toBe(128_000);
    expect(outputLimitProblem(200_000, 150_000, defaults)).toBe(150_000);
    expect(outputLimitProblem(127_999, null, defaults)).toBeUndefined();
    expect(outputLimitProblem(null, 2_048, defaults)).toBeUndefined();
  });
});
