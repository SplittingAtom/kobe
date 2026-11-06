import { beforeEach, describe, expect, it } from "vitest";
import { assistant, entry, resetEntrySeq, text, user } from "../../lib/chat/testing/entries";
import { initialThreadState, type ThreadState } from "../../lib/chat/thread-state";
import type { ThreadSummary } from "../../lib/chat/types";
import { gaugeSize } from "./context-gauge";

beforeEach(() => resetEntrySeq());

describe("the gauge follows the head (CT16, KOBE-544)", () => {
  const usage = (input: number) => ({ input, cacheRead: 0, cacheWrite: 0 });
  const entries = [
    user("u1", null, "q"),
    entry("a1", "u1", { role: "assistant", content: [text("x")], usage: usage(900) }),
    user("u2", null, "other"),
    assistant("a2", "u2", text("y")),
  ];
  const state = (head?: string): ThreadState => ({
    ...initialThreadState("t1"),
    phase: "ready",
    summary: { threadId: "t1", leafEntryId: "a2" } as ThreadSummary,
    entries,
    ...(head === undefined ? {} : { head }),
  });
  const read = { afterRun: null, usage: { latestCall: null } } as unknown as Parameters<
    typeof gaugeSize
  >[1];

  it("on a browsed branch, reads that branch's newest call", () => {
    expect(gaugeSize(state("a1"), read)).toEqual({ tokens: 900, counter: null });
  });

  it("on the leaf, reads the thread's newest call as before", () => {
    expect(gaugeSize(state(), read)).toBeNull();
  });
});
