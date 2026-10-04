import { describe, expect, it } from "vitest";
import type { RouteKind } from "../routes.js";
import { JsonUsageScanner } from "./json-scan.js";
import { DEFAULT_CHARGED_OUTPUT_TOKENS, MAX_CHARGED_OUTPUT_TOKENS } from "./charge.js";
import { UsageMeter } from "./meter.js";

const SSE = "text/event-stream";
const JSON_TYPE = "application/json";

/** Feeds `body` in chunks of `size` bytes (splitting lines and UTF-8 sequences). */
function meter(
  kind: RouteKind,
  type: string,
  body: string,
  size = 7,
  complete = true,
  requested?: number,
) {
  const m = new UsageMeter({ kind, contentType: type, contentEncoding: undefined });
  const bytes = Buffer.from(body, "utf8");
  for (let i = 0; i < bytes.length; i += size) m.write(bytes.subarray(i, i + size));
  return m.finish(complete, 400, requested);
}

const data = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const event = (type: string, v: unknown) => `event: ${type}\r\ndata: ${JSON.stringify(v)}\r\n\r\n`;

describe("UsageMeter: streams (usage in the final events)", () => {
  it("OpenAI Chat Completions: the include_usage chunk; cached tokens split from input", () => {
    const body =
      data({ choices: [{ delta: { content: "héllo" } }] }) +
      data({
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      }) +
      "data: [DONE]\n\n";
    expect(meter("openai", SSE, body)).toEqual({
      source: "reported",
      counts: { input: 20, output: 30, cacheRead: 100, cacheWrite: 0 },
    });
  });

  it("OpenAI Responses: response.completed carries the usage", () => {
    const body =
      event("response.output_text.delta", { type: "response.output_text.delta", delta: "hi" }) +
      event("response.completed", {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 50,
            output_tokens: 9,
            input_tokens_details: { cached_tokens: 10 },
            output_tokens_details: { reasoning_tokens: 4 },
          },
        },
      });
    expect(meter("openai", SSE, body, 5)).toEqual({
      source: "reported",
      counts: { input: 40, output: 9, cacheRead: 10, cacheWrite: 0 },
    });
  });

  it("Anthropic: message_start input and cache counts, message_delta's final output", () => {
    const body =
      event("message_start", {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 12,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 2000,
            output_tokens: 1,
          },
        },
      }) +
      event("content_block_delta", {
        type: "content_block_delta",
        delta: { type: "text_delta", text: 'usage: {"output_tokens": 99999}' },
      }) +
      event("message_delta", { type: "message_delta", usage: { output_tokens: 42 } }) +
      event("message_stop", { type: "message_stop" });
    expect(meter("anthropic", SSE, body, 3)).toEqual({
      source: "reported",
      counts: { input: 12, output: 42, cacheRead: 2000, cacheWrite: 300 },
    });
  });

  it("Gemini: the last chunk's usageMetadata (thinking counts as output)", () => {
    const chunk = (text: string, usage: unknown) =>
      data({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage });
    const body =
      chunk("a", { promptTokenCount: 80 }) +
      chunk("b", {
        promptTokenCount: 80,
        cachedContentTokenCount: 60,
        candidatesTokenCount: 7,
        thoughtsTokenCount: 5,
      });
    expect(meter("gemini", SSE, body)).toEqual({
      source: "reported",
      counts: { input: 20, output: 12, cacheRead: 60, cacheWrite: 0 },
    });
  });

  it("estimates a stream without a usage report: the larger of text / 4 and the output cap", () => {
    const body = data({ choices: [{ delta: { content: "x".repeat(400) } }] }) + "data: [DONE]\n\n";
    // The request asked for at most 50 tokens: the 100 seen count.
    expect(meter("openai", SSE, body, 7, true, 50)).toEqual({
      source: "estimated",
      counts: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 },
    });
    // It asked for 4,000 (hidden reasoning is never streamed): 4,000.
    expect(meter("openai", SSE, body, 7, true, 4_000).counts.output).toBe(4_000);
    // No cap in the request: the default; a huge one: the documented maximum.
    expect(meter("openai", SSE, body).counts.output).toBe(DEFAULT_CHARGED_OUTPUT_TOKENS);
    expect(meter("openai", SSE, body, 7, true, 10_000_000).counts.output).toBe(
      MAX_CHARGED_OUTPUT_TOKENS,
    );
  });

  it("estimates a stream cut short, keeping the input side already reported", () => {
    const body =
      event("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 12, cache_read_input_tokens: 7, output_tokens: 1 } },
      }) +
      event("content_block_delta", {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "y".repeat(80) },
      });
    expect(meter("anthropic", SSE, body, 9, false, 16)).toEqual({
      source: "estimated",
      counts: { input: 12, output: 20, cacheRead: 7, cacheWrite: 0 },
    });
  });

  it("reads the usage of an event too long to decode whole (never drops the report)", () => {
    const long = "w".repeat(200);
    const body =
      event("response.completed", {
        type: "response.completed",
        response: {
          output: [{ content: [{ text: long }] }],
          usage: { input_tokens: 7, output_tokens: 70_000 },
        },
      }) +
      data({
        candidates: [{ content: { parts: [{ text: long }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      });
    const openai = new UsageMeter({
      kind: "openai",
      contentType: SSE,
      contentEncoding: undefined,
      maxLineBytes: 64,
    });
    openai.write(Buffer.from(body));
    expect(openai.finish(true, 0)).toEqual({
      source: "reported",
      counts: { input: 7, output: 70_000, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("merges reports field by field, keeping the larger count", () => {
    const body =
      event("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 12, output_tokens: 1 } },
      }) +
      event("message_delta", {
        type: "message_delta",
        usage: { input_tokens: 0, output_tokens: 42 },
      });
    expect(meter("anthropic", SSE, body)).toEqual({
      source: "reported",
      counts: { input: 12, output: 42, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("a usage report from a stream that did not complete is still an estimate", () => {
    const body = data({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    expect(meter("openai", SSE, body, 100, false).source).toBe("estimated");
  });

  it("skips over-long lines (counted as generated text) and keeps going", () => {
    const m = new UsageMeter({
      kind: "openai",
      contentType: SSE,
      contentEncoding: undefined,
      maxLineBytes: 120,
    });
    m.write(Buffer.from(data({ choices: [{ delta: { content: "z".repeat(400) } }] })));
    m.write(Buffer.from(data({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })));
    expect(m.finish(true, 0)).toEqual({
      source: "reported",
      counts: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
  });
});

describe("UsageMeter: JSON bodies", () => {
  it("OpenAI non-streaming: the top-level usage only, not one inside the answer", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: '{"usage": {"prompt_tokens": 1}}', usage: { x: 1 } } }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    });
    expect(meter("openai", JSON_TYPE, body, 4)).toEqual({
      source: "reported",
      counts: { input: 9, output: 4, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("Anthropic non-streaming", () => {
    const body = JSON.stringify({
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 },
    });
    expect(meter("anthropic", "application/json; charset=utf-8", body)).toEqual({
      source: "reported",
      counts: { input: 5, output: 3, cacheRead: 2, cacheWrite: 0 },
    });
  });

  it("Gemini's JSON array of chunks: the last element's usageMetadata", () => {
    const body = JSON.stringify([
      { candidates: [], usageMetadata: { promptTokenCount: 4 } },
      { candidates: [], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6 } },
    ]);
    expect(meter("gemini", JSON_TYPE, body, 3)).toEqual({
      source: "reported",
      counts: { input: 4, output: 6, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("estimates a JSON body without usage from its size", () => {
    const body = JSON.stringify({ choices: [{ message: { content: "a".repeat(100) } }] });
    const reading = meter("openai", JSON_TYPE, body, 7, true, 1);
    expect(reading.source).toBe("estimated");
    expect(reading.counts.output).toBe(Math.ceil(body.length / 4));
  });

  it("an encoded or unknown body is estimated from its size", () => {
    const m = new UsageMeter({ kind: "openai", contentType: SSE, contentEncoding: "gzip" });
    m.write(Buffer.alloc(40));
    expect(m.finish(true, 8, 1)).toEqual({
      source: "estimated",
      counts: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
    });
  });
});

describe("JsonUsageScanner", () => {
  const scan = (text: string) => {
    const s = new JsonUsageScanner(64);
    s.write(Buffer.from(text));
    return s.values.map((f) => f.value);
  };

  it("captures object and primitive values at member depth only", () => {
    expect(scan('{"a":{"usage":1},"usage":{"n":[1,{"x":"}"}]},"b":2}')).toEqual([
      { n: [1, { x: "}" }] },
    ]);
    expect(scan('{"usage":null,"x":1}')).toEqual([null]);
    expect(scan('{"x":"\\"usage\\":{}","usage":7}')).toEqual([7]);
  });

  it("captures usage one level down in a top-level response or message object only", () => {
    const s = new JsonUsageScanner();
    s.write(
      Buffer.from(
        '{"type":"x","response":{"output":[{"usage":1}],"usage":{"input_tokens":3}},"other":{"usage":9}}',
      ),
    );
    expect(s.values).toEqual([{ parent: "response", key: "usage", value: { input_tokens: 3 } }]);
  });

  it("drops a value larger than its cap", () => {
    expect(scan(`{"usage":{"t":"${"q".repeat(100)}"}}`)).toEqual([]);
  });
});
