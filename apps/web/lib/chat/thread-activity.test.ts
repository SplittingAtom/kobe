import { describe, expect, it, vi } from "vitest";
import {
  activityOfSummary,
  readActivity,
  stripTitlePrefix,
  ThreadActivityStore,
  titlePrefix,
} from "./thread-activity";
import type { ThreadSummary } from "./types";

const summary = (over: Partial<ThreadSummary>): ThreadSummary =>
  ({ threadId: "t", status: "idle", deletedAt: null, ...over }) as ThreadSummary;

describe("thread activity (KOBE-301)", () => {
  it("reads a summary: an approval for the caller wins over a run; Trash is idle", () => {
    expect(activityOfSummary(summary({}))).toBe("idle");
    expect(activityOfSummary(summary({ status: "running" }))).toBe("running");
    expect(activityOfSummary(summary({ status: "running", pendingApproval: true }))).toBe(
      "approval",
    );
    expect(activityOfSummary(summary({ status: "interrupted" }))).toBe("idle");
    expect(
      activityOfSummary(summary({ status: "running", deletedAt: "2026-10-16T10:00:00Z" })),
    ).toBe("idle");
  });

  it("reads `custom.activity` back defensively", () => {
    expect(readActivity({ activity: "approval" })).toBe("approval");
    expect(readActivity({ activity: "bogus" })).toBe("idle");
    expect(readActivity(undefined)).toBe("idle");
  });

  it("titles: an approval anywhere first, then a run; prefixes come off again", () => {
    expect(titlePrefix(["idle", "running"])).toBe("● ");
    expect(titlePrefix(["running", "approval"])).toBe("(!) ");
    expect(titlePrefix(["idle"])).toBe("");
    expect(stripTitlePrefix("● Kobe")).toBe("Kobe");
    expect(stripTitlePrefix("(!) Kobe")).toBe("Kobe");
    expect(stripTitlePrefix("Kobe")).toBe("Kobe");
  });

  it("the store keeps immutable snapshots and reports a thread let go after a run as stale", () => {
    const store = new ThreadActivityStore();
    const changed = vi.fn();
    const stale = vi.fn();
    store.subscribe(changed);
    store.onStale(stale);
    const first = store.snapshot();
    store.set("a", "idle");
    expect(store.snapshot()).not.toBe(first);
    expect(first.size).toBe(0);
    store.set("a", "idle"); // no change, no notification
    expect(changed).toHaveBeenCalledTimes(1);
    store.release("a");
    expect(stale).not.toHaveBeenCalled(); // never ran while held: the list is current
    store.set("b", "running");
    store.set("b", "idle");
    store.release("b");
    expect(stale).toHaveBeenCalledWith("b");
    expect(store.get("b")).toBeUndefined();
  });
});
