import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTEXT_CAPTURE_MAX_BYTES,
  CONTEXT_FILE_ENV,
  ContextRecorder,
  captureText,
  isContextTemp,
  promptUsage,
  takeContextFilePath,
} from "./context-capture.js";

const MODEL = { id: "glm-5", contextWindow: 200_000 };
const NOW = new Date("2026-10-21T10:00:00.000Z");
const answer = (input: number, cacheRead = 0, cacheWrite = 0) => ({
  role: "assistant",
  usage: { input, cacheRead, cacheWrite, output: 5 },
});

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("context capture (KOBE-470)", () => {
  it("takes the file from the environment once and removes it", () => {
    const env: Record<string, string | undefined> = { [CONTEXT_FILE_ENV]: "/run/x/agent/c.json" };
    expect(takeContextFilePath(env)).toBe("/run/x/agent/c.json");
    expect(env[CONTEXT_FILE_ENV]).toBeUndefined();
    expect(takeContextFilePath({ [CONTEXT_FILE_ENV]: "relative.json" })).toBeUndefined();
  });

  it("keeps the answer's prompt tokens, or null when it reported none", () => {
    expect(promptUsage(answer(100, 20, 3))).toEqual({ input: 100, cacheRead: 20, cacheWrite: 3 });
    expect(promptUsage(answer(0))).toBeNull();
    expect(promptUsage({ role: "assistant" })).toBeNull();
  });

  it("records the context as sent, without image data", () => {
    const context = {
      systemPrompt: "be brief",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data: "QUJD", mimeType: "image/png" },
          ],
        },
      ],
    };
    const parsed = JSON.parse(captureText(MODEL, context, answer(42), NOW));
    expect(parsed).toMatchObject({
      v: 1,
      captured_at: NOW.toISOString(),
      model: { id: "glm-5", context_window: 200_000 },
      usage: { input: 42, cacheRead: 0, cacheWrite: 0 },
    });
    expect(parsed.context.systemPrompt).toBe("be brief");
    expect(parsed.context.messages[0].content[1]).toEqual({
      type: "image",
      data: "",
      data_chars: 4,
      mimeType: "image/png",
    });
  });

  it("writes a stub for a context over the cap", () => {
    const huge = { messages: [{ role: "user", content: "x".repeat(CONTEXT_CAPTURE_MAX_BYTES) }] };
    const parsed = JSON.parse(captureText(MODEL, huge, answer(1), NOW));
    expect(parsed.too_large).toBe(true);
    expect(parsed.context).toBeUndefined();
  });

  it("writes the newest call atomically (0640) and skips summaries", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-ctx-"));
    const file = path.join(dir, "kobe-context.json");
    const recorder = new ContextRecorder(file, { now: () => NOW });
    recorder.record(MODEL, { messages: [{ role: "user", content: "one" }] }, undefined, answer(1));
    recorder.record(MODEL, { messages: [{ role: "user", content: "two" }] }, {}, answer(2));
    recorder.record(
      MODEL,
      { messages: [{ role: "user", content: "summarize" }] },
      { cacheRetention: "none" },
      answer(3),
    );
    await recorder.settled();
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed.context.messages[0].content).toBe("two");
    expect(parsed.usage.input).toBe(2);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect((await readdir(dir)).filter(isContextTemp)).toEqual([]);
  });

  it("only warns when the write fails", async () => {
    const warnings: string[] = [];
    const recorder = new ContextRecorder("/nonexistent/dir/kobe-context.json", {
      warn: (m) => warnings.push(m),
    });
    recorder.record(MODEL, { messages: [] }, undefined, answer(1));
    await recorder.settled();
    expect(warnings).toHaveLength(1);
  });
});
