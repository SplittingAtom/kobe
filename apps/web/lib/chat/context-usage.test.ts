import { describe, expect, it } from "vitest";
import {
  contextPercent,
  gaugeLabel,
  gaugeLevel,
  messageContextTokens,
  newestContextTokens,
} from "./context-usage";

/** KOBE-211 (CE14): what the context gauge reads and says. */
const assistant = (usage: Record<string, unknown> | undefined) => ({
  type: "message",
  message: { role: "assistant", content: [], ...(usage ? { usage } : {}) },
});

describe("messageContextTokens", () => {
  it("is the prompt plus cache-read tokens of an assistant message (Pi usage)", () => {
    expect(
      messageContextTokens(
        assistant({ input: 2_000, output: 300, cacheRead: 140_000, cacheWrite: 50 }),
      ),
    ).toBe(142_000);
  });

  it("ignores other entries, messages without usage and calls that read nothing", () => {
    expect(messageContextTokens(undefined)).toBeUndefined();
    expect(messageContextTokens({ type: "message", message: { role: "user" } })).toBeUndefined();
    expect(messageContextTokens(assistant(undefined))).toBeUndefined();
    expect(messageContextTokens(assistant({ input: 0, cacheRead: 0 }))).toBeUndefined();
    expect(messageContextTokens(assistant({ input: "9", cacheRead: null }))).toBeUndefined();
    expect(messageContextTokens(assistant({ input: 10 }))).toBe(10);
  });
});

describe("newestContextTokens", () => {
  const live = { runId: "r2", contextTokens: 120_000 };
  const read = (afterRun: string | null, tokens = 150_000) => ({
    afterRun,
    latestCall: { inputTokens: tokens - 1_000, cacheReadTokens: 1_000 },
  });

  it("is empty before the first model call", () => {
    expect(newestContextTokens(undefined, null)).toBeNull();
    expect(newestContextTokens(undefined, { afterRun: null, latestCall: null })).toBeNull();
  });

  it("takes run_usage on load, the stream during a run, and run_usage again once re-read after it", () => {
    expect(newestContextTokens(undefined, read(null))).toBe(150_000);
    expect(newestContextTokens(live, read(null))).toBe(120_000);
    expect(newestContextTokens({ runId: "r2" }, read(null))).toBe(150_000);
    expect(newestContextTokens(live, read("r2", 121_000))).toBe(121_000);
    expect(newestContextTokens(live, { afterRun: "r2", latestCall: null })).toBe(120_000);
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

  it("is empty before the first turn", () => {
    expect(gaugeLabel({ tokens: null, window: 200_000, model: "Claude" })).toBe(
      "0 of 200k tokens (0%) · Claude",
    );
    expect(gaugeLabel({ tokens: null, window: null, model: null })).toBe("0 tokens");
  });
});
