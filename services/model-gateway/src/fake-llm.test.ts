import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeLlm, lastToolResult, systemMarker } from "./testing/fake-llm.js";

/** The fake provider's scripted tool call (KOBE-39 e2e: a bash tool call through real Pi). */
const server = createFakeLlm();
let base = "";
beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const chat = (messages: unknown[]) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-fake", messages }),
  }).then(
    (r) =>
      r.json() as Promise<{
        choices: { message: Record<string, unknown>; finish_reason: string }[];
      }>,
  );

describe("fake LLM tool use", () => {
  it("answers 'bash: <command>' with a bash tool call", async () => {
    const res = await chat([{ role: "user", content: "bash: curl -sS https://x.example/" }]);
    expect(res.choices[0]?.finish_reason).toBe("tool_calls");
    expect(res.choices[0]?.message.tool_calls).toEqual([
      {
        id: "call_fake_bash",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "curl -sS https://x.example/" }),
        },
      },
    ]);
  });

  it("echoes the tool's result on one line, bounded", async () => {
    const res = await chat([
      { role: "user", content: "bash: x" },
      { role: "tool", tool_call_id: "call_fake_bash", content: "line one\nline two" },
    ]);
    expect(res.choices[0]?.message.content).toBe("fake-openai: tool said: line one line two");
    expect(
      lastToolResult({
        messages: [{ role: "tool", content: [{ type: "text", text: "a".repeat(900) }] }],
      }),
    ).toHaveLength(600);
    expect(lastToolResult({ messages: [{ role: "user", content: "hi" }] })).toBeUndefined();
  });

  it("still echoes plain prompts", async () => {
    const res = await chat([{ role: "user", content: "hello" }]);
    expect(res.choices[0]?.message.content).toBe("fake-openai: hello");
  });

  it("echoes the marker found in the system prompt (KOBE-123)", async () => {
    const res = await chat([
      { role: "system", content: "You are x. KOBE-PROMPT-MARKER:tok_1-a and more" },
      { role: "user", content: "hello" },
    ]);
    expect(res.choices[0]?.message.content).toBe("fake-openai: hello [system-marker: tok_1-a]");
    expect(systemMarker({ messages: [{ role: "user", content: "KOBE-PROMPT-MARKER:no" }] })).toBe(
      undefined,
    );
    expect(
      systemMarker({
        messages: [
          { role: "developer", content: [{ type: "text", text: "KOBE-PROMPT-MARKER:d1" }] },
        ],
      }),
    ).toBe("d1");
  });
});
