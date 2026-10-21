import { NOTEBOOK_TRUNCATED_PREFIX, type NotebookOutput } from "@kobe/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTPUT_LIMITS, OutputLimiter, sanitizeOutput, type OutputLimits } from "./outputs.js";

function collect(limits: Partial<OutputLimits> = {}) {
  const sent: { index: number; output: NotebookOutput }[] = [];
  const limiter = new OutputLimiter((index, output) => sent.push({ index, output }), {
    ...OUTPUT_LIMITS,
    ...limits,
  });
  return { limiter, sent };
}

afterEach(() => vi.useRealTimers());

describe("sanitizeOutput (NB4)", () => {
  it("keeps allow-listed MIME types, joins line arrays and drops the rest", () => {
    expect(
      sanitizeOutput({
        output_type: "display_data",
        data: {
          "text/html": ["<b>", "x</b>"],
          "image/png": "iVBO\nRw0=",
          "application/javascript": "alert(1)",
          "application/vnd.jupyter.widget-view+json": { model_id: "m" },
        },
        metadata: { "image/png": { width: 10 } },
      }),
    ).toEqual({
      output_type: "display_data",
      data: { "text/html": "<b>x</b>", "image/png": "iVBORw0=" },
      metadata: { "image/png": { width: 10 } },
    });
    expect(
      sanitizeOutput({ output_type: "display_data", data: { "application/javascript": "x" } }),
    ).toBeUndefined();
    expect(sanitizeOutput({ output_type: "clear_output" })).toBeUndefined();
    expect(sanitizeOutput("nonsense")).toBeUndefined();
  });

  it("replaces NUL and keeps the stream name to stdout/stderr", () => {
    expect(sanitizeOutput({ output_type: "stream", name: "stdin", text: "a\u0000b" })).toEqual({
      output_type: "stream",
      name: "stdout",
      text: "a�b",
    });
  });
});

describe("OutputLimiter (NB9)", () => {
  it("coalesces stream text and flushes before rich output, in order", () => {
    const { limiter, sent } = collect();
    limiter.push({ output_type: "stream", name: "stdout", text: "a" });
    limiter.push({ output_type: "stream", name: "stdout", text: "b" });
    limiter.push({ output_type: "stream", name: "stderr", text: "warn" });
    limiter.push({
      output_type: "execute_result",
      execution_count: 2,
      data: { "text/plain": "2" },
      metadata: {},
    });
    expect(limiter.finish()).toEqual({ outputs: 3, truncated: false });
    expect(sent.map((s) => [s.index, s.output])).toEqual([
      [0, { output_type: "stream", name: "stdout", text: "ab" }],
      [1, { output_type: "stream", name: "stderr", text: "warn" }],
      [
        2,
        {
          output_type: "execute_result",
          execution_count: 2,
          data: { "text/plain": "2" },
          metadata: {},
        },
      ],
    ]);
  });

  it("flushes pending stream text after the flush interval", () => {
    vi.useFakeTimers();
    const { limiter, sent } = collect({ flushMs: 100 });
    limiter.push({ output_type: "stream", name: "stdout", text: "tick" });
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
  });

  it("splits a huge print into chunks and ends with one marker at the byte cap", () => {
    const { limiter, sent } = collect({ coalesceBytes: 1000, maxBytes: 10_000 });
    limiter.push({ output_type: "stream", name: "stdout", text: "x".repeat(50_000) });
    limiter.push({ output_type: "stream", name: "stdout", text: "more" });
    const result = limiter.finish();
    expect(result.truncated).toBe(true);
    const last = sent.at(-1)?.output;
    expect(last?.output_type === "stream" && last.text.startsWith(NOTEBOOK_TRUNCATED_PREFIX)).toBe(
      true,
    );
    const total = sent.reduce((n, s) => n + Buffer.byteLength(JSON.stringify(s.output)), 0);
    expect(total).toBeLessThanOrEqual(10_000);
    expect(sent.map((s) => s.index)).toEqual(sent.map((_, i) => i));
  });

  it("stops at the output count cap with the marker as the last output", () => {
    const { limiter, sent } = collect({ maxOutputs: 5 });
    for (let i = 0; i < 20; i++) {
      limiter.push({ output_type: "display_data", data: { "text/plain": `${i}` }, metadata: {} });
    }
    expect(limiter.finish()).toEqual({ outputs: 5, truncated: true });
    expect(sent).toHaveLength(5);
  });

  it("replaces an image over the per-output cap by a note keeping its text", () => {
    const { limiter, sent } = collect({ maxOutputBytes: 2000 });
    limiter.push({
      output_type: "display_data",
      data: { "image/png": "A".repeat(10_000), "text/plain": "<Figure>" },
      metadata: {},
    });
    const out = sent[0]?.output;
    expect(out?.output_type).toBe("stream");
    expect(out?.output_type === "stream" && out.text).toMatch(
      /^\[Kobe: output truncated.*<Figure>/su,
    );
    expect(limiter.finish().truncated).toBe(false);
  });

  it("cuts a long traceback from the top, keeping the innermost frames", () => {
    const { limiter, sent } = collect({ maxOutputBytes: 4000 });
    const traceback = Array.from({ length: 500 }, (_, i) => `frame ${i}`);
    limiter.push({ output_type: "error", ename: "RecursionError", evalue: "deep", traceback });
    const out = sent[0]?.output;
    expect(out?.output_type).toBe("error");
    if (out?.output_type !== "error") return;
    expect(out.traceback.at(-1)).toBe("frame 499");
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(4000);
  });
});
