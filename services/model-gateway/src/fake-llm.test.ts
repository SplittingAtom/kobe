import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeLlm, lastToolResult } from "./testing/fake-llm.js";

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

  it("answers 'tool: <name> <json>' with that tool call and a content-derived id", async () => {
    const args = { kind: "html", title: "T", content: "<p>hi</p>" };
    const prompt = `tool: create_artifact ${JSON.stringify(args)}`;
    const a = await chat([{ role: "user", content: prompt }]);
    const b = await chat([{ role: "user", content: `${prompt.slice(0, -1)} }` }]);
    const calls = a.choices[0]?.message.tool_calls as {
      id: string;
      function: { name: string; arguments: string };
    }[];
    expect(a.choices[0]?.finish_reason).toBe("tool_calls");
    expect(calls[0]?.function.name).toBe("create_artifact");
    expect(JSON.parse(calls[0]?.function.arguments ?? "")).toEqual(args);
    expect(calls[0]?.id).toMatch(/^call_fake_[0-9a-f]{16}$/);
    expect((b.choices[0]?.message.tool_calls as { id: string }[])[0]?.id).not.toBe(calls[0]?.id);
  });

  it("treats a malformed 'tool:' prompt as plain text", async () => {
    const res = await chat([{ role: "user", content: "tool: nope {bad" }]);
    expect(res.choices[0]?.message.content).toBe("fake-openai: tool: nope {bad");
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
});

describe("fake LLM system prompt echo (KOBE-89)", () => {
  it("answers 'system?' with the system and developer messages on one line", async () => {
    const res = await chat([
      { role: "system", content: "Be  brief.\nBe kind." },
      { role: "developer", content: [{ type: "text", text: "Extra." }] },
      { role: "user", content: "system?" },
    ]);
    expect(res.choices[0]?.message.content).toBe(
      "fake-openai: system said: Be brief. Be kind. Extra.",
    );
  });
});
