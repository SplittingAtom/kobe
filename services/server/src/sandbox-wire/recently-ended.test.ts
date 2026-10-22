import { describe, expect, it } from "vitest";
import { RecentlyEndedRuns } from "./recently-ended.js";

describe("RecentlyEndedRuns (KOBE-483)", () => {
  it("matches a run on its own thread within the grace window only", () => {
    let now = 1_000;
    const recent = new RecentlyEndedRuns(30_000, 10, () => now);
    recent.add("r1", "t1");
    expect(recent.match("r1", "t1")).toBe("match");
    expect(recent.match("r1", "t2")).toBe("thread_mismatch");
    expect(recent.match("r2", "t1")).toBe("none");
    now += 29_999;
    expect(recent.match("r1", "t1")).toBe("match");
    now += 1;
    expect(recent.match("r1", "t1")).toBe("none");
    expect(recent.size).toBe(0);
  });

  it("keeps at most `max` runs, forgetting the oldest", () => {
    const recent = new RecentlyEndedRuns(30_000, 2, () => 0);
    recent.add("a", "t");
    recent.add("b", "t");
    recent.add("c", "t");
    expect(recent.size).toBe(2);
    expect(recent.match("a", "t")).toBe("none");
    expect(recent.match("c", "t")).toBe("match");
  });

  it("re-adding a run refreshes its time", () => {
    let now = 0;
    const recent = new RecentlyEndedRuns(10, 5, () => now);
    recent.add("a", "t");
    now = 8;
    recent.add("a", "t");
    now = 15;
    expect(recent.match("a", "t")).toBe("match");
  });
});
