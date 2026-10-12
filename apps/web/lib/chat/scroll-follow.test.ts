// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PIN_DISTANCE_PX,
  createScrollSaver,
  distanceFromBottom,
  isPinned,
  loadScroll,
  newSince,
  overflows,
  saveScroll,
  scrollDirection,
  shownCount,
} from "./scroll-follow";

/** KOBE-205 (CE9): the follow rules and the per-thread scroll memory, without a layout engine. */
const box = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe("pinned within 48 px of the bottom", () => {
  it("measures the distance left to scroll", () => {
    expect(distanceFromBottom(box(1500))).toBe(0);
    expect(distanceFromBottom(box(1400))).toBe(100);
  });

  it("follows at the bottom and up to 48 px above it, not beyond", () => {
    expect(PIN_DISTANCE_PX).toBe(48);
    expect(isPinned(box(1500))).toBe(true);
    expect(isPinned(box(1500 - 48))).toBe(true);
    expect(isPinned(box(1500 - 49))).toBe(false);
    expect(isPinned(box(0))).toBe(false);
  });

  it("a list that fits without scrolling is pinned", () => {
    expect(isPinned(box(0, 300, 500))).toBe(true);
  });
});

describe("who moved the list", () => {
  it("a move over unchanged content is the member's, in its direction", () => {
    expect(scrollDirection({ top: 500, height: 2000 }, { top: 490, height: 2000 })).toBe("up");
    expect(scrollDirection({ top: 500, height: 2000 }, { top: 520, height: 2000 })).toBe("down");
  });

  it("growth, shrinking and scroll anchoring are not", () => {
    expect(scrollDirection({ top: 500, height: 2000 }, { top: 480, height: 1980 })).toBeNull();
    expect(scrollDirection({ top: 500, height: 2000 }, { top: 700, height: 2200 })).toBeNull();
    expect(scrollDirection({ top: 500, height: 2000 }, { top: 500, height: 2000 })).toBeNull();
  });

  it("only an overflowing list can be scrolled away from the bottom", () => {
    expect(overflows(box(0, 2000))).toBe(true);
    expect(overflows(box(0, 500))).toBe(false);
  });
});

describe("the pill's count of new messages", () => {
  const msg = (isOptimistic = false) => ({ metadata: { isOptimistic } });

  it("leaves out assistant-ui's optimistic placeholder", () => {
    expect(shownCount([msg(), msg(), msg(true)])).toBe(2);
    expect(shownCount([])).toBe(0);
  });

  it("counts messages added since the member scrolled up, never below zero", () => {
    expect(newSince(4, 4)).toBe(0);
    expect(newSince(4, 6)).toBe(2);
    // A branch switch can shorten the list.
    expect(newSince(4, 2)).toBe(0);
  });
});

describe("scroll memory per thread (sessionStorage)", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips a position and the bottom", () => {
    saveScroll("t1", 320.6);
    saveScroll("t2", "bottom");
    expect(loadScroll("t1")).toBe(321);
    expect(loadScroll("t2")).toBe("bottom");
    expect(loadScroll("t3")).toBeNull();
  });

  it("ignores values it did not write", () => {
    sessionStorage.setItem("kobe.scroll:t1", "-5");
    sessionStorage.setItem("kobe.scroll:t2", "not a number");
    sessionStorage.setItem("kobe.scroll:t3", "Infinity");
    expect(loadScroll("t1")).toBeNull();
    expect(loadScroll("t2")).toBeNull();
    expect(loadScroll("t3")).toBeNull();
  });

  it("coalesces writes until scrolling settles, and flushes at once", () => {
    vi.useFakeTimers();
    try {
      const saver = createScrollSaver(200);
      saver.schedule("t1", 10);
      saver.schedule("t1", 20);
      expect(loadScroll("t1")).toBeNull();
      vi.advanceTimersByTime(200);
      expect(loadScroll("t1")).toBe(20);

      saver.schedule("t1", 30);
      saver.flush();
      expect(loadScroll("t1")).toBe(30);
      // A position for another thread first writes the pending one under its own key.
      saver.schedule("t1", 40);
      saver.schedule("t2", 50);
      expect(loadScroll("t1")).toBe(40);
      saver.flush();
      expect(loadScroll("t2")).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("works without storage (private mode, blocked site data)", () => {
    const refuse = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("sessionStorage", { getItem: refuse, setItem: refuse });
    expect(() => saveScroll("t1", 10)).not.toThrow();
    expect(loadScroll("t1")).toBeNull();
  });
});
