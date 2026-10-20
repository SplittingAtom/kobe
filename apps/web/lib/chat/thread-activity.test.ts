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

  it("a teammate's run on a thread shared with the member is not theirs to watch (S1)", () => {
    expect(activityOfSummary(summary({ status: "running", readOnly: true }))).toBe("idle");
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
    expect(first.live.size).toBe(0);
    store.set("a", "idle"); // no change, no notification
    expect(changed).toHaveBeenCalledTimes(1);
    store.release("a");
    expect(stale).not.toHaveBeenCalled(); // never ran while held
    store.set("b", "running");
    store.set("b", "idle");
    store.release("b");
    expect(stale).toHaveBeenCalledWith("b");
    expect(store.get("b")).toBeUndefined(); // nothing polled yet: the list decides
  });

  it("held threads win over the server's answer; unlisted threads are idle once it answered", () => {
    const store = new ThreadActivityStore();
    store.setPolled(new Map([["a", "approval"]]));
    expect(store.get("a")).toBe("approval");
    expect(store.get("z")).toBe("idle");
    store.set("a", "running");
    expect(store.get("a")).toBe("running");
    const before = store.snapshot();
    store.setPolled(new Map([["a", "approval"]])); // same answer: no new snapshot
    expect(store.snapshot()).toBe(before);
  });
});

describe("new activity (KOBE-453)", () => {
  it("a thread that ran off screen and is idle again is unread until it is on screen", () => {
    const store = new ThreadActivityStore();
    store.setOnScreen("b");
    store.setPolled(new Map([["a", "running"]]));
    expect(store.snapshot().unread.size).toBe(0);
    store.setPolled(new Map());
    expect([...store.snapshot().unread]).toEqual(["a"]);
    store.setOnScreen("a");
    expect(store.snapshot().unread.size).toBe(0);
  });

  it("the thread on screen never becomes unread; an approval that went counts too", () => {
    const store = new ThreadActivityStore();
    store.setOnScreen("a");
    store.set("a", "running");
    store.set("a", "idle");
    expect(store.snapshot().unread.size).toBe(0);
    store.setOnScreen(null);
    store.setPolled(new Map([["c", "approval"]]));
    store.setPolled(new Map([["c", "idle"]]));
    expect([...store.snapshot().unread]).toEqual(["c"]);
  });

  it("still running elsewhere (released, the poll not in yet) is not unread", () => {
    const store = new ThreadActivityStore();
    store.setPolled(new Map([["a", "running"]]));
    store.set("a", "running");
    store.release("a");
    expect(store.snapshot().unread.size).toBe(0);
  });
});
