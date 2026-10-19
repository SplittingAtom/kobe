import { describe, expect, it } from "vitest";
import { MAX_LIVE_FRAMES, releaseSlot, takeSlot } from "./live-slots";

describe("live app frames per thread (KOBE-438 ac-5)", () => {
  it("allows three, refuses a fourth unless forced, which retires the least recent", () => {
    let live: readonly string[] = [];
    for (const k of ["a", "b", "c"]) live = takeSlot(live, k, false);
    expect(live).toEqual(["a", "b", "c"]);
    expect(MAX_LIVE_FRAMES).toBe(3);
    expect(takeSlot(live, "d", false)).toBe(live);
    // "a" came back into view: most recent now, so "b" is the one a click retires.
    live = takeSlot(live, "a", false);
    expect(live).toEqual(["b", "c", "a"]);
    expect(takeSlot(live, "d", true)).toEqual(["c", "a", "d"]);
  });

  it("frees a slot when a card leaves", () => {
    expect(releaseSlot(["a", "b"], "a")).toEqual(["b"]);
    const live = ["a"];
    expect(releaseSlot(live, "z")).toBe(live);
  });
});
