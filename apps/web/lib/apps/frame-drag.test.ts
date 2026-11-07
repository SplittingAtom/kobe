import { describe, expect, it } from "vitest";
import {
  FrameDragStore,
  frameDragRelay,
  pagePoint,
  pointInRect,
  type FrameDragEvent,
} from "./frame-drag";

/**
 * KOBE-553: the session's live frame drag (DRAG-CONTRACT.md "Host behaviour"): one at a time,
 * in page coordinates, with the app's title as `from`; the composer and the ghost subscribe.
 */
const ITEM = { kind: "table", identifier: "mlb.lahman.batting" };

function watch(store: FrameDragStore) {
  const seen: FrameDragEvent[] = [];
  store.subscribe((event) => seen.push(event));
  return seen;
}

describe("FrameDragStore (KOBE-553)", () => {
  it("holds the live drag from start to end and tells subscribers each phase", () => {
    const store = new FrameDragStore();
    const seen = watch(store);
    expect(store.current()).toBeNull();
    const live = store.start(ITEM, "Lakehouse Picker", 10, 20);
    expect(store.current()).toEqual({ item: ITEM, from: "Lakehouse Picker", x: 10, y: 20 });
    live.move(30, 40);
    expect(store.current()).toMatchObject({ x: 30, y: 40 });
    live.end(50, 60);
    expect(store.current()).toBeNull();
    expect(seen.map((e) => [e.phase, e.drag.x, e.drag.y])).toEqual([
      ["start", 10, 20],
      ["move", 30, 40],
      ["end", 50, 60],
    ]);
    expect(seen.at(-1)?.drag).toEqual({ item: ITEM, from: "Lakehouse Picker", x: 50, y: 60 });
  });

  it("a cancel clears it; the handle is spent afterwards", () => {
    const store = new FrameDragStore();
    const seen = watch(store);
    const live = store.start(ITEM, "P", 1, 1);
    live.cancel();
    live.move(2, 2);
    live.end(3, 3);
    expect(store.current()).toBeNull();
    expect(seen.map((e) => e.phase)).toEqual(["start", "cancel"]);
  });

  it("a second start replaces the live one: the first is cancelled and its handle spent", () => {
    const store = new FrameDragStore();
    const seen = watch(store);
    const first = store.start(ITEM, "A", 1, 1);
    const second = store.start({ kind: "view" }, "B", 5, 5);
    first.end(2, 2);
    first.move(2, 2);
    expect(store.current()).toMatchObject({ from: "B", x: 5, y: 5 });
    second.end(6, 6);
    expect(seen.map((e) => [e.phase, e.drag.from])).toEqual([
      ["start", "A"],
      ["cancel", "A"],
      ["start", "B"],
      ["end", "B"],
    ]);
  });

  it("cancel() stops whatever drag is live, and is quiet when none is", () => {
    const store = new FrameDragStore();
    const seen = watch(store);
    store.cancel();
    const live = store.start(ITEM, "A", 1, 1);
    store.cancel();
    live.end(1, 1);
    expect(seen.map((e) => e.phase)).toEqual(["start", "cancel"]);
  });

  it("unsubscribes", () => {
    const store = new FrameDragStore();
    const seen: FrameDragEvent[] = [];
    const off = store.subscribe((e) => seen.push(e));
    off();
    store.start(ITEM, "A", 1, 1);
    expect(seen).toEqual([]);
  });
});

describe("frameDragRelay (KOBE-553)", () => {
  it("drives one frame's drag in the store, with the app's title", () => {
    const store = new FrameDragStore();
    const seen = watch(store);
    const relay = frameDragRelay(store);
    relay({ phase: "start", item: ITEM, x: 1, y: 2 }, "Lakehouse Picker");
    relay({ phase: "move", x: 3, y: 4 }, "Lakehouse Picker");
    relay({ phase: "end", x: 5, y: 6 }, "Lakehouse Picker");
    relay({ phase: "move", x: 7, y: 8 }, "Lakehouse Picker");
    expect(seen.map((e) => [e.phase, e.drag.from, e.drag.x])).toEqual([
      ["start", "Lakehouse Picker", 1],
      ["move", "Lakehouse Picker", 3],
      ["end", "Lakehouse Picker", 5],
    ]);
  });

  it("starts nothing for a frame with no composer (from null)", () => {
    const store = new FrameDragStore();
    const relay = frameDragRelay(store);
    relay({ phase: "start", item: ITEM, x: 1, y: 2 }, null);
    relay({ phase: "end", x: 1, y: 2 }, null);
    expect(store.current()).toBeNull();
  });

  it("one frame's late moves never move another frame's drag", () => {
    const store = new FrameDragStore();
    const a = frameDragRelay(store);
    const b = frameDragRelay(store);
    a({ phase: "start", item: ITEM, x: 1, y: 1 }, "A");
    b({ phase: "start", item: ITEM, x: 9, y: 9 }, "B");
    a({ phase: "move", x: 2, y: 2 }, "A");
    a({ phase: "end", x: 2, y: 2 }, "A");
    expect(store.current()).toMatchObject({ from: "B", x: 9, y: 9 });
    b({ phase: "cancel" }, "B");
    expect(store.current()).toBeNull();
  });
});

describe("page geometry (KOBE-553 ac-2)", () => {
  it("adds the frame's offset to its frame-relative point", () => {
    expect(pagePoint({ left: 70, top: 50 }, 353, 203)).toEqual({ x: 423, y: 253 });
    // A frame scrolled partly out of view has a negative top.
    expect(pagePoint({ left: 900, top: -120 }, -40, 10)).toEqual({ x: 860, y: -110 });
  });

  it("a point is inside a rect including its edges", () => {
    const rect = { left: 10, top: 20, right: 110, bottom: 70 };
    expect(pointInRect(rect, 10, 20)).toBe(true);
    expect(pointInRect(rect, 110, 70)).toBe(true);
    expect(pointInRect(rect, 60, 40)).toBe(true);
    expect(pointInRect(rect, 9.9, 40)).toBe(false);
    expect(pointInRect(rect, 60, 70.1)).toBe(false);
  });
});
