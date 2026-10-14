import { describe, expect, it } from "vitest";
import {
  compactedSinceLastCall,
  contextPercent,
  gaugeLabel,
  gaugeLevel,
  messageContextTokens,
  newestContextSize,
  type UsageRead,
} from "./context-usage";

/** KOBE-211 (CE14): what the context gauge reads and says. */
const assistant = (usage: Record<string, unknown> | undefined) => ({
  type: "message",
  message: { role: "assistant", content: [], ...(usage ? { usage } : {}) },
});

describe("messageContextTokens: input + cache read + cache write, each prompt token once", () => {
  // Pi's Usage as pi-ai 1.0.0 builds it from each provider's report (the three are disjoint).
  it.each([
    [
      "Anthropic (input_tokens 12, cache_read 40k, cache_creation 100k)",
      { input: 12, output: 300, cacheRead: 40_000, cacheWrite: 100_000 },
      140_012,
    ],
    [
      "OpenAI chat (prompt_tokens 142k incl. cached_tokens 140k)",
      { input: 2_000, output: 300, cacheRead: 140_000, cacheWrite: 0 },
      142_000,
    ],
    [
      "OpenAI responses (input_tokens 150k incl. cached 100k and cache_write 20k)",
      { input: 30_000, output: 10, cacheRead: 100_000, cacheWrite: 20_000 },
      150_000,
    ],
    [
      "Gemini (promptTokenCount 90k incl. cachedContentTokenCount 60k)",
      { input: 30_000, output: 10, cacheRead: 60_000, cacheWrite: 0 },
      90_000,
    ],
    ["a provider without caching", { input: 8_000, output: 10 }, 8_000],
  ])("%s", (_shape, usage, expected) => {
    expect(messageContextTokens(assistant(usage))).toBe(expected);
  });

  it("ignores other entries, messages without usage and calls that read nothing", () => {
    expect(messageContextTokens(undefined)).toBeUndefined();
    expect(messageContextTokens({ type: "message", message: { role: "user" } })).toBeUndefined();
    expect(messageContextTokens(assistant(undefined))).toBeUndefined();
    expect(messageContextTokens(assistant({ input: 0, cacheRead: 0 }))).toBeUndefined();
    expect(messageContextTokens(assistant({ input: "9", cacheRead: null }))).toBeUndefined();
  });
});

describe("compactedSinceLastCall", () => {
  const e = (type: string, payload: Record<string, unknown> = {}, payloadOffloaded = false) => ({
    type,
    payload,
    payloadOffloaded,
  });
  const answer = e("message", assistant({ input: 10 }));

  it("is true when a compaction entry follows the newest answer with usage", () => {
    expect(compactedSinceLastCall([answer, e("compaction"), e("message", { message: {} })])).toBe(
      true,
    );
    expect(compactedSinceLastCall([e("compaction"), answer])).toBe(false);
    expect(compactedSinceLastCall([answer])).toBe(false);
    expect(compactedSinceLastCall([])).toBe(false);
  });

  it("treats an offloaded message as a possible later answer", () => {
    expect(compactedSinceLastCall([e("compaction"), e("message", {}, true)])).toBe(false);
  });
});

describe("newestContextSize", () => {
  const read = (afterRun: string | null, runId: string, tokens = 150_000): UsageRead => ({
    afterRun,
    latestCall: {
      runId,
      model: "ollama/kimi",
      inputTokens: tokens - 11_000,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 10_000,
    },
  });
  const live = (contextTokens?: number | null) => ({ runId: "r2", model: "glm", contextTokens });
  const size = (...args: Parameters<typeof newestContextSize>) =>
    newestContextSize(...args)?.tokens ?? null;

  it("is unknown before the first call", () => {
    expect(newestContextSize(undefined, null, false)).toBeNull();
    expect(newestContextSize(undefined, { afterRun: null, latestCall: null }, false)).toBeNull();
  });

  it("takes run_usage (all three counts) on load, with the gateway model that counted it", () => {
    expect(newestContextSize(undefined, read(null, "r1"), false)).toEqual({
      tokens: 150_000,
      counter: { gatewayModel: "ollama/kimi" },
    });
  });

  it("takes the stream during a run, with the run's alias", () => {
    expect(newestContextSize(live(120_000), read(null, "r1"), false)).toEqual({
      tokens: 120_000,
      counter: { alias: "glm" },
    });
    // Nothing streamed yet: what was loaded.
    expect(size(live(), read(null, "r1"), false)).toBe(150_000);
  });

  it("takes run_usage after the run only when the read holds that run's call", () => {
    expect(size(live(120_000), read("r2", "r2", 121_000), false)).toBe(121_000);
    // A stale read (the newest row is still the previous run's) keeps the streamed value.
    expect(size(live(120_000), read("r2", "r1"), false)).toBe(120_000);
    // A read from before the run ended, even of this run's call, may predate its last message.
    expect(size(live(120_000), read(null, "r2", 90_000), false)).toBe(120_000);
  });

  it("is unknown after a compaction until the next call", () => {
    expect(newestContextSize(undefined, read(null, "r1"), true)).toBeNull();
    expect(newestContextSize(live(null), read("r2", "r2"), true)).toBeNull();
    expect(newestContextSize(live(null), read(null, "r1"), false)).toBeNull();
  });
});

describe("thresholds", () => {
  it("is green below 65%, orange from 65%, red from 85%", () => {
    expect(gaugeLevel(0)).toBe("ok");
    expect(gaugeLevel(64.9)).toBe("ok");
    expect(gaugeLevel(65)).toBe("warn");
    expect(gaugeLevel(84.9)).toBe("warn");
    expect(gaugeLevel(85)).toBe("full");
    expect(gaugeLevel(140)).toBe("full");
  });

  it("measures against the window", () => {
    expect(contextPercent(142_000, 200_000)).toBe(71);
    expect(contextPercent(130_000, 200_000)).toBe(65);
    expect(contextPercent(129_999, 200_000)).toBeLessThan(65);
  });
});

describe("gaugeLabel", () => {
  it("says tokens of the window, the share and the model", () => {
    expect(gaugeLabel({ tokens: 142_000, window: 200_000, model: "Claude" })).toBe(
      "142k of 200k tokens (71%) · Claude",
    );
    expect(gaugeLabel({ tokens: 1_234_567, window: 2_000_000, model: null })).toBe(
      "1.2M of 2M tokens (61%)",
    );
  });

  it("shows tokens only when the window is blank", () => {
    expect(gaugeLabel({ tokens: 142_000, window: null, model: "GLM 5.3" })).toBe(
      "142k tokens · GLM 5.3",
    );
  });

  it("says when another model counted the tokens", () => {
    expect(
      gaugeLabel({ tokens: 150_000, window: 1_000_000, model: "GLM 5.3", countedBy: "Kimi" }),
    ).toBe("150k of 1M tokens (15%) · GLM 5.3 · counted by Kimi");
  });
});
