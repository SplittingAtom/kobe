import { describe, expect, it } from "vitest";
import { appendPage, placeItem, type ScopeLists } from "./item-lists";
import type { MemoryItem } from "./items-api";

const item = (id: string, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id,
  scope: "user",
  kind: "fact",
  status: "active",
  statement: id,
  tags: [],
  pinned: false,
  policy: false,
  asOf: null,
  version: 1,
  updatedAt: "2026-11-10T10:00:00Z",
  ...over,
});

const lists = (over: Partial<ScopeLists> = {}): ScopeLists => ({
  pinned: [],
  others: { items: [item("a"), item("b")], nextCursor: "c" },
  archived: null,
  usage: { count: 2, max: 300 },
  ...over,
});

const ids = (items: readonly MemoryItem[]) => items.map((i) => i.id);

describe("Me editor lists (KOBE-384 review M1)", () => {
  it("a new item goes first and counts", () => {
    const next = placeItem(lists(), item("n"));
    expect(ids(next.others.items)).toEqual(["n", "a", "b"]);
    expect(next.usage.count).toBe(3);
    expect(next.others.nextCursor).toBe("c");
  });

  it("an edit stays in place", () => {
    const next = placeItem(lists(), item("b", { statement: "B2", version: 2 }));
    expect(ids(next.others.items)).toEqual(["a", "b"]);
    expect(next.others.items[1]?.statement).toBe("B2");
    expect(next.usage.count).toBe(2);
  });

  it("a pin moves to the pinned list; unpin moves back", () => {
    const pinned = placeItem(lists(), item("b", { pinned: true }));
    expect(ids(pinned.pinned)).toEqual(["b"]);
    expect(ids(pinned.others.items)).toEqual(["a"]);
    expect(pinned.usage.count).toBe(2);
    expect(ids(placeItem(pinned, item("b")).others.items)).toEqual(["b", "a"]);
  });

  it("archive leaves the active lists (and enters an open archive); restore comes back", () => {
    const open = lists({ archived: { items: [], nextCursor: null } });
    const archived = placeItem(open, item("a", { status: "archived" }));
    expect(ids(archived.others.items)).toEqual(["b"]);
    expect(ids(archived.archived?.items ?? [])).toEqual(["a"]);
    expect(archived.usage.count).toBe(1);
    const restored = placeItem(archived, item("a"));
    expect(ids(restored.archived?.items ?? [])).toEqual([]);
    expect(restored.usage.count).toBe(2);
    expect(placeItem(lists(), item("a", { status: "archived" })).archived).toBeNull();
  });

  it("further pages skip items already listed", () => {
    const next = appendPage(
      { items: [item("a")], nextCursor: "c" },
      {
        scope: "user",
        items: [item("a"), item("z")],
        nextCursor: null,
        usage: { count: 2, max: 3 },
      },
    );
    expect(ids(next.items)).toEqual(["a", "z"]);
    expect(next.nextCursor).toBeNull();
  });
});
