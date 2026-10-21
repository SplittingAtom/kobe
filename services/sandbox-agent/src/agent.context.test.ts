import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { threadContextResultSchema } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { captureText } from "./kobe-models/context-capture.js";
import type { ModelWiring } from "./models/types.js";
import { THREAD, runStart, startHarness, until, type Harness } from "./testing/harness.js";

/**
 * `thread.context` through the agent (KOBE-470, docs/specs/context-viewer.md) with the scripted
 * Pi: nothing before any call, the session file's latest call, and the capture kobe-models writes
 * into the running Pi's private dir.
 */
let h: Harness | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

const contextOf = async (harness: Harness) => {
  const result = await harness.server.command({
    type: "thread.context",
    thread_id: THREAD,
    max_bytes: 1_000_000,
  });
  expect(result).toMatchObject({ ok: true });
  return threadContextResultSchema.parse((result as { data?: unknown }).data);
};

describe("thread.context (KOBE-470)", () => {
  it("announces the capability and answers none before any model call", async () => {
    h = await startHarness();
    expect(h.server.frames("hello").at(-1)?.capabilities).toContain("thread_context");
    expect(await contextOf(h)).toMatchObject({ source: "none", sections: [], total_tokens: 0 });
  });

  it("rebuilds the latest call from the session file when nothing was captured", async () => {
    h = await startHarness();
    const lines = [
      { type: "session", version: 3, id: THREAD },
      { type: "message", id: "a", parentId: null, message: { role: "user", content: "hi" } },
      {
        type: "message",
        id: "b",
        parentId: "a",
        message: {
          role: "assistant",
          model: "glm-5",
          content: [{ type: "text", text: "hello" }],
          usage: { input: 321, cacheRead: 0, cacheWrite: 0 },
          timestamp: 1_792_000_000_000,
        },
      },
    ];
    await mkdir(h.sessions, { recursive: true });
    await writeFile(
      path.join(h.sessions, `${THREAD}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    expect(await contextOf(h)).toMatchObject({
      source: "session",
      model: "glm-5",
      total_tokens: 321,
      tokens_basis: "usage",
      sections: [{ kind: "user_message", text: "hi", tokens: 321 }],
    });
  });

  it("answers what the running Pi's kobe-models recorded", async () => {
    const models: ModelWiring = {
      gatewayUrl: "http://model-gateway.kobe.internal:80",
      extension: "/opt/kobe/pi-extensions/kobe-models/index.js",
      tokens: { current: async () => "t".repeat(40), onChange: () => () => undefined },
    };
    h = await startHarness({ models });
    const model = { alias: "fast", gateway_model: "openai/gpt-fake", api: "openai-completions" };
    expect(await h.server.command(runStart("hang", { config: { model } }))).toMatchObject({
      ok: true,
    });
    const [launch] = (await h.commandsLog()) as { agentDir: string }[];
    const file = path.join(launch?.agentDir as string, "kobe-context.json");
    const context = {
      messages: [
        { role: "system", content: "", sections: { preamble: "Pi" } },
        { role: "user", content: "what is 2+2?" },
      ],
    };
    await writeFile(
      file,
      captureText(
        { id: "openai/gpt-fake", contextWindow: 64_000 },
        context,
        { usage: { input: 50, cacheRead: 50, cacheWrite: 0 } },
        new Date("2026-10-21T10:00:00.000Z"),
      ),
    );
    await until(async () => (await contextOf(h as Harness)).source === "model_call");
    expect(await contextOf(h)).toMatchObject({
      source: "model_call",
      model: "openai/gpt-fake",
      context_window: 64_000,
      total_tokens: 100,
      sections: [{ kind: "system_prompt" }, { kind: "user_message", text: "what is 2+2?" }],
    });
  });
});
