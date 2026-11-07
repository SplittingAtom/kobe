import { describe, expect, it } from "vitest";
import { normalizeAnthropic, normalizeGemini, normalizeOpenAi, usageOf } from "./normalize.js";

/** KOBE-557: the reasoning split each provider reports (real response samples, trimmed). */
describe("reasoning tokens in provider usage reports", () => {
  it("OpenAI Chat Completions: completion_tokens_details.reasoning_tokens", () => {
    const usage = {
      prompt_tokens: 19,
      completion_tokens: 1_420,
      total_tokens: 1_439,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 1_344,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    };
    expect(normalizeOpenAi(usage)).toEqual({
      input: 19,
      cacheRead: 0,
      output: 1_420,
      reasoning: 1_344,
    });
  });

  it("OpenAI Responses: output_tokens_details.reasoning_tokens (in response.completed)", () => {
    const event = {
      type: "response.completed",
      response: {
        id: "resp_67ccd2bed1ec8190b14f964abc0542670bb6a6b452d3795b",
        status: "completed",
        usage: {
          input_tokens: 75,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1_186,
          output_tokens_details: { reasoning_tokens: 1_024 },
          total_tokens: 1_261,
        },
      },
    };
    expect(usageOf("openai", event)).toEqual({
      counts: { input: 75, cacheRead: 0, output: 1_186, reasoning: 1_024 },
      final: true,
    });
  });

  it("Gemini: usageMetadata.thoughtsTokenCount (output already includes it)", () => {
    const usageMetadata = {
      promptTokenCount: 11,
      candidatesTokenCount: 312,
      totalTokenCount: 1_201,
      promptTokensDetails: [{ modality: "TEXT", tokenCount: 11 }],
      thoughtsTokenCount: 878,
    };
    expect(normalizeGemini(usageMetadata)).toEqual({
      input: 11,
      cacheRead: 0,
      output: 1_190,
      reasoning: 878,
    });
  });

  it("Anthropic reports no split; OpenAI and Gemini without one report none", () => {
    expect(
      normalizeAnthropic({
        input_tokens: 2_095,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 503,
      }),
    ).not.toHaveProperty("reasoning");
    expect(normalizeOpenAi({ prompt_tokens: 5, completion_tokens: 7 })).not.toHaveProperty(
      "reasoning",
    );
    expect(normalizeGemini({ promptTokenCount: 5, candidatesTokenCount: 7 })).not.toHaveProperty(
      "reasoning",
    );
  });
});
