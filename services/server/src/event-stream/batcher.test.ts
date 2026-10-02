import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewRunEvent } from "./append.js";
import { createRunEventBatcher } from "./batcher.js";

const text = (delta: string, message_id = "m1", content_index = 0): NewRunEvent => ({
  type: "text.delta",
  payload: { message_id, content_index, delta },
});
const reasoning = (delta: string): NewRunEvent => ({
  type: "reasoning.delta",
  payload: { message_id: "m1", content_index: 1, delta },
});
const toolCall: NewRunEvent = {
  type: "tool.call",
  payload: { tool_call_id: "t1", tool: "read", input: {}, risk: "read" },
};

function recorder(delayMs = 0) {
  const writes: NewRunEvent[][] = [];
  const write = async (events: NewRunEvent[]) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    writes.push(events);
  };
  return { writes, write };
}

describe("run event batcher (ac-8)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces deltas of one message part within the window", async () => {
    const { writes, write } = recorder();
    const b = createRunEventBatcher({ write, windowMs: 75 });
    for (const piece of ["Hel", "lo", ", ", "world"]) await b.push(text(piece));
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(75);
    expect(writes).toEqual([[text("Hello, world")]]);
  });

  it("keeps different parts, messages and types apart, in order", async () => {
    const { writes, write } = recorder();
    const b = createRunEventBatcher({ write });
    await b.push(text("a"));
    await b.push(text("b"));
    await b.push(reasoning("r"));
    await b.push(text("c", "m1", 1));
    await b.push(text("d", "m2"));
    await b.flush();
    expect(writes.flat()).toEqual([
      text("ab"),
      reasoning("r"),
      text("c", "m1", 1),
      text("d", "m2"),
    ]);
  });

  it("writes pending deltas before any other event, at once", async () => {
    const { writes, write } = recorder();
    const b = createRunEventBatcher({ write, windowMs: 10_000 });
    await b.push(text("x"));
    await b.push(toolCall);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([[text("x"), toolCall]]);
  });

  it("caps a coalesced delta's size", async () => {
    const { writes, write } = recorder();
    const b = createRunEventBatcher({ write, maxDeltaChars: 4 });
    for (const p of ["ab", "cd", "ef"]) await b.push(text(p));
    await b.flush();
    expect(writes.flat()).toEqual([text("abcd"), text("ef")]);
  });

  it("splits large backlogs into batches of at most maxBatchEvents", async () => {
    const { writes, write } = recorder();
    const b = createRunEventBatcher({ write, maxBatchEvents: 3, highWaterMark: 100 });
    for (let i = 0; i < 7; i++) void b.push(text(String(i), `m${i}`));
    await b.flush();
    expect(writes.map((w) => w.length)).toEqual([3, 3, 1]);
    expect(writes.flat().map((e) => (e.payload as { delta: string }).delta)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
  });

  it("does not merge into a batch that is already being written", async () => {
    const { writes, write } = recorder(50);
    const b = createRunEventBatcher({ write, windowMs: 10 });
    await b.push(text("a"));
    await vi.advanceTimersByTimeAsync(10); // write of "a" in flight
    await b.push(text("b"));
    await vi.advanceTimersByTimeAsync(200);
    expect(writes).toEqual([[text("a")], [text("b")]]);
  });

  it("pushes back once highWaterMark events wait", async () => {
    const { writes, write } = recorder(100);
    const b = createRunEventBatcher({ write, highWaterMark: 2, maxBatchEvents: 1 });
    await b.push(toolCall);
    await b.push(text("1", "a"));
    let resolved = false;
    const p = b.push(text("2", "b")).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(resolved).toBe(true);
    await b.close();
    expect(writes.flat()).toHaveLength(3);
  });

  it("fails sticky after a write error and reports background failures", async () => {
    const onError = vi.fn();
    const b = createRunEventBatcher({
      write: () => Promise.reject(new Error("db down")),
      onError,
    });
    await b.push(toolCall);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "db down" }));
    await expect(b.push(text("x"))).rejects.toThrow("db down");
    await expect(b.flush()).rejects.toThrow("db down");
  });

  it("refuses events after close", async () => {
    const { writes, write } = recorder();
    const b = createRunEventBatcher({ write });
    await b.push(text("a"));
    await b.close();
    expect(writes.flat()).toEqual([text("a")]);
    await expect(b.push(text("b"))).rejects.toThrow("closed");
  });
});
