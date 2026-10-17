import {
  MODEL_PROVIDER_KINDS,
  THINKING_CONTROLS as DB_CONTROLS,
  THINKING_CONTROLS_WITHOUT_OFF as DB_WITHOUT_OFF,
  THINKING_LEVELS as DB_LEVELS,
} from "@kobe/db";
import {
  THINKING_CONTROLS,
  THINKING_CONTROLS_BY_KIND,
  THINKING_CONTROLS_WITHOUT_OFF,
  THINKING_LEVELS,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { chatThinking, checkCatalogThinking, NO_THINKING, runThinkingLevel } from "./thinking.js";

const EFFORT = {
  control: "reasoning_effort",
  allowed: true,
  default: "medium",
  max: "high",
} as const;

describe("thinking settings on the server (KOBE-260)", () => {
  it("the database checks the same levels and controls as the protocol", () => {
    expect([...DB_LEVELS]).toEqual([...THINKING_LEVELS]);
    expect([...DB_CONTROLS]).toEqual([...THINKING_CONTROLS]);
    expect([...DB_WITHOUT_OFF]).toEqual([...THINKING_CONTROLS_WITHOUT_OFF]);
    // Every provider kind has its controls listed.
    expect(Object.keys(THINKING_CONTROLS_BY_KIND).sort()).toEqual([...MODEL_PROVIDER_KINDS].sort());
  });

  it("checks a catalog write against the provider kind and the reasoning flag", () => {
    expect(checkCatalogThinking(EFFORT, NO_THINKING, "ollama", true)).toEqual({
      ok: true,
      policy: EFFORT,
    });
    expect(checkCatalogThinking(undefined, EFFORT, "ollama", false)).toMatchObject({
      ok: false,
      error: "thinking_invalid",
    });
    expect(checkCatalogThinking(EFFORT, NO_THINKING, "anthropic", true)).toMatchObject({
      ok: false,
      message: expect.stringContaining("anthropic"),
    });
    // Moving the model to another provider kind re-checks the stored control.
    expect(checkCatalogThinking(undefined, EFFORT, "gemini", true)).toMatchObject({ ok: false });
    expect(checkCatalogThinking(undefined, NO_THINKING, "gemini", false)).toMatchObject({
      ok: true,
    });
  });

  it("clamps a run's level to the site's and the team's maximum (ac-2)", () => {
    expect(runThinkingLevel(EFFORT, null, null)).toBe("medium");
    expect(runThinkingLevel(EFFORT, null, "high")).toBe("high");
    expect(runThinkingLevel(EFFORT, "low", "high")).toBe("low");
    expect(runThinkingLevel(EFFORT, "low", null)).toBe("low");
    expect(runThinkingLevel(EFFORT, "off", "high")).toBe("off");
    expect(runThinkingLevel(NO_THINKING, null, "high")).toBeUndefined();
  });

  it("tells the chat the team's default and the levels to offer", () => {
    expect(chatThinking(EFFORT, null)).toEqual({
      default: "medium",
      levels: ["off", "low", "medium", "high"],
    });
    expect(chatThinking(EFFORT, "low")).toEqual({ default: "low", levels: ["off", "low"] });
    expect(chatThinking(EFFORT, "off")).toEqual({ default: "off", levels: [] });
    expect(chatThinking(NO_THINKING, null)).toEqual({ default: null, levels: [] });
  });
});
