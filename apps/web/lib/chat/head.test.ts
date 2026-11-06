import { beforeEach, describe, expect, it } from "vitest";
import {
  branchContextTokens,
  branchLeafOf,
  headOf,
  isBrowsing,
  messagesDiffer,
  onBranchOf,
  settleHead,
} from "./head";
import { assistant, entry, resetEntrySeq, text, user } from "./testing/entries";
import { initialThreadState, type ThreadState } from "./thread-state";
import { projectThread } from "./tree";
import type { ThreadEntry, ThreadSummary } from "./types";

beforeEach(() => resetEntrySeq());

/** u1 → a1 → (u2 → a2 | u2b → a2b → u3b → a3b): two branches under a1. */
function forked(): ThreadEntry[] {
  return [
    user("u1", null, "start"),
    assistant("a1", "u1", text("a1")),
    user("u2", "a1", "old question"),
    assistant("a2", "u2", text("old answer")),
    user("u2b", "a1", "new question"),
    assistant("a2b", "u2b", text("new answer")),
    user("u3b", "a2b", "more"),
    assistant("a3b", "u3b", text("more answer")),
  ];
}

function stateWith(leaf: string | null, head?: string): ThreadState {
  return {
    ...initialThreadState("t1"),
    phase: "ready",
    summary: { threadId: "t1", leafEntryId: leaf } as ThreadSummary,
    entries: forked(),
    ...(head === undefined ? {} : { head }),
  };
}

describe("the local head (CT3)", () => {
  it("is the leaf until something moves it", () => {
    expect(headOf(stateWith("a3b"))).toBe("a3b");
    expect(isBrowsing(stateWith("a3b"))).toBe(false);
    expect(headOf(stateWith("a3b", "a2"))).toBe("a2");
    expect(isBrowsing(stateWith("a3b", "a2"))).toBe(true);
  });

  it("settles back onto the leaf once the leaf reaches it", () => {
    const s = stateWith("a2", "a2");
    expect(settleHead(s).head).toBeUndefined();
    const browsing = stateWith("a3b", "a2");
    expect(settleHead(browsing)).toBe(browsing);
  });

  it("finds a branch's newest leaf below an entry", () => {
    const entries = forked();
    expect(branchLeafOf(entries, "u2")).toBe("a2");
    expect(branchLeafOf(entries, "a1")).toBe("a3b");
    expect(branchLeafOf(entries, "a3b")).toBe("a3b");
    expect(branchLeafOf(entries, "missing")).toBeUndefined();
  });

  it("tells whether an entry is on the leaf's branch", () => {
    const entries = forked();
    expect(onBranchOf(entries, "a3b", "u2b")).toBe(true);
    expect(onBranchOf(entries, "a3b", "a1")).toBe(true);
    expect(onBranchOf(entries, "a3b", "u2")).toBe(false);
    expect(onBranchOf(entries, null, "u2")).toBe(false);
  });

  it("counts the messages on screen that the leaf's branch does not have", () => {
    const entries = forked();
    const p = projectThread(entries, "a2");
    expect(messagesDiffer(entries, p.nodeOfEntry, "a2", "a3b")).toBe(2);
    expect(messagesDiffer(entries, p.nodeOfEntry, "a3b", "a2")).toBe(4);
    expect(messagesDiffer(entries, p.nodeOfEntry, "a2", "a2")).toBe(0);
  });

  it("reads the branch's newest prompt size, unknown after a compaction (CT16)", () => {
    const usage = (input: number) => ({ input, cacheRead: 0, cacheWrite: 0 });
    const entries = [
      user("u1", null, "q"),
      entry("a1", "u1", { role: "assistant", content: [text("x")], usage: usage(1000) }),
      user("u2", "a1", "q2"),
      entry("a2", "u2", { role: "assistant", content: [text("y")], usage: usage(5000) }),
      user("u2b", "a1", "q2b"),
      entry("a2b", "u2b", { role: "assistant", content: [text("z")], usage: usage(250_000) }),
      entry("c1", "a2", null, "compaction"),
    ];
    expect(branchContextTokens(entries, "a2b")).toBe(250_000);
    expect(branchContextTokens(entries, "a2")).toBe(5000);
    expect(branchContextTokens(entries, "c1")).toBeNull();
    expect(branchContextTokens(entries, "u1")).toBeUndefined();
  });
});
