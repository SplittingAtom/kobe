import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { THREAD_CONTEXT_MAX_BYTES } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { captureText } from "../kobe-models/context-capture.js";
import { fromCapture, fromSession, parseCapture, readCapture } from "./assemble.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const NOW = new Date("2026-10-21T10:00:00.000Z");
const context = {
  messages: [
    { role: "system", content: "", sections: { preamble: "Pi" }, toolsAdded: [{ name: "bash" }] },
    { role: "user", content: "hi" },
  ],
};
const answer = { role: "assistant", usage: { input: 900, cacheRead: 100, cacheWrite: 0 } };

describe("thread.context answer (KOBE-470)", () => {
  it("reads the capture and totals the call's prompt tokens", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-assemble-"));
    const file = path.join(dir, "kobe-context.json");
    await writeFile(
      file,
      captureText({ id: "glm-5", contextWindow: 128_000 }, context, answer, NOW),
    );
    const capture = await readCapture(file);
    expect(capture).toMatchObject({ model: "glm-5", contextWindow: 128_000, promptTokens: 1000 });
    if (capture === undefined) throw new Error("no capture");
    const result = fromCapture(capture, undefined, THREAD_CONTEXT_MAX_BYTES);
    expect(result).toMatchObject({
      source: "model_call",
      captured_at: NOW.toISOString(),
      model: "glm-5",
      context_window: 128_000,
      total_tokens: 1000,
      tokens_basis: "usage",
    });
    expect(result.sections.map((s) => s.kind)).toEqual([
      "system_prompt",
      "tool_definitions",
      "user_message",
    ]);
  });

  it("refuses a malformed or stub capture", () => {
    expect(parseCapture("{")).toBeUndefined();
    expect(
      parseCapture(JSON.stringify({ v: 2, captured_at: NOW.toISOString(), context: {} })),
    ).toBeUndefined();
    expect(
      parseCapture(JSON.stringify({ v: 1, captured_at: NOW.toISOString(), too_large: true })),
    ).toBeUndefined();
  });

  it("answers from the session, or none before any call", () => {
    const fromReplay = fromSession(
      {
        messages: [{ role: "user", content: "hi" }],
        answer: {
          role: "assistant",
          model: "glm-5",
          usage: { input: 42 },
          timestamp: NOW.getTime(),
        },
      },
      200_000,
      THREAD_CONTEXT_MAX_BYTES,
    );
    expect(fromReplay).toMatchObject({
      source: "session",
      model: "glm-5",
      captured_at: NOW.toISOString(),
      total_tokens: 42,
      context_window: 200_000,
    });
    expect(fromReplay.missing).not.toContain("older_history");
    const cut = fromSession(
      {
        messages: [],
        answer: { role: "assistant", usage: { input: 1 } },
        historyCut: true,
      },
      null,
      THREAD_CONTEXT_MAX_BYTES,
    );
    expect(cut).toMatchObject({ exact: false });
    expect(cut.missing).toContain("older_history");
    expect(fromSession(undefined, null, THREAD_CONTEXT_MAX_BYTES)).toMatchObject({
      source: "none",
      sections: [],
      total_tokens: 0,
      tokens_basis: "estimate",
    });
  });
});
