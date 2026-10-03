import { describe, expect, it } from "vitest";
import { classify, forwardedQuery } from "./routes.js";

describe("classify", () => {
  it("knows the inference endpoints of each SDK", () => {
    expect(classify("POST", "/v1/chat/completions")?.kind).toBe("openai");
    expect(classify("POST", "/v1/responses")?.kind).toBe("openai");
    expect(classify("GET", "/v1/models")?.kind).toBe("openai");
    expect(classify("POST", "/anthropic/v1/messages")?.kind).toBe("anthropic");
    expect(classify("POST", "/anthropic/v1/messages/count_tokens")?.kind).toBe("anthropic");
    expect(classify("POST", "/genai/v1beta/models/gemini/gemini-2.5-pro:generateContent")).toEqual({
      kind: "gemini",
      path: "/genai/v1beta/models/gemini/gemini-2.5-pro:generateContent",
      pathModel: "gemini/gemini-2.5-pro",
    });
  });

  it("refuses everything else", () => {
    for (const [m, p] of [
      ["GET", "/api/providers"],
      ["POST", "/v1/chat/completions/../../api"],
      ["POST", "//v1/chat/completions"],
      ["POST", "/v1/embeddings"],
      ["DELETE", "/v1/chat/completions"],
      ["POST", "/genai/v1beta/models/x:embedContent"],
      ["POST", "/genai/v1beta/models/%2e%2e:generateContent"],
      ["POST", "/openai/v1/chat/completions"],
    ] as const) {
      expect(classify(m, p), `${m} ${p}`).toBeUndefined();
    }
  });
});

describe("forwardedQuery", () => {
  it("keeps alt=sse only, never key", () => {
    expect(forwardedQuery(new URLSearchParams("alt=sse&key=secret&x=1"))).toBe("?alt=sse");
    expect(forwardedQuery(new URLSearchParams("key=secret"))).toBe("");
  });
});
