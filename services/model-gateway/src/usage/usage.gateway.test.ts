import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalGateway, type LocalGateway } from "../testing/local-gateway.js";
import { usageRecordOf } from "./sink.js";

/**
 * KOBE-43 through the real shim and the fake upstream: the usage each API reports in its final
 * stream events (or its JSON body) reaches the usage record.
 */
let gw: LocalGateway;

beforeAll(async () => {
  gw = await startLocalGateway({ enabledModels: ["openai/m", "anthropic/c", "gemini/g"] });
});
afterAll(() => gw.close());

async function call(path: string, body: unknown): Promise<string> {
  const res = await fetch(`${gw.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${gw.mintToken()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.text();
}

const REPORTED = {
  source: "reported",
  counts: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 },
};

describe("usage from the upstream response", () => {
  it.each([
    ["OpenAI stream", "/v1/chat/completions", { model: "openai/m", stream: true }],
    ["OpenAI JSON", "/v1/chat/completions", { model: "openai/m" }],
    ["Anthropic stream", "/anthropic/v1/messages", { model: "anthropic/c", stream: true }],
    ["Anthropic JSON", "/anthropic/v1/messages", { model: "anthropic/c" }],
    ["Gemini SSE", "/genai/v1beta/models/gemini/g:streamGenerateContent?alt=sse", {}],
    ["Gemini JSON", "/genai/v1beta/models/gemini/g:generateContent", {}],
  ])("%s", async (_name, path, body) => {
    const before = gw.calls.length;
    await call(path, { ...body, messages: [{ role: "user", content: "hi" }] });
    for (let i = 0; i < 50 && gw.calls.length === before; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const record = gw.calls.at(-1);
    if (!record) throw new Error("no usage record");
    expect(record.usage).toEqual(REPORTED);
    expect(record.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(usageRecordOf(record)).toMatchObject({
      teamId: gw.identity.teamId,
      userId: gw.identity.userId,
      sandboxId: gw.identity.sandboxId,
      inputTokens: 5,
      outputTokens: 3,
      usageSource: "reported",
      status: 200,
    });
  });
});
