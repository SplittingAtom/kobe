import { describe, expect, it } from "vitest";
import { mentionMarker } from "@kobe/protocol";
import { MentionStore } from "./mentions";

describe("dropped-file chips in the MentionStore", () => {
  it("keeps chips per draft, once each, and appends their markers on send", () => {
    const store = new MentionStore();
    store.addChip("t1", "a.csv");
    store.addChip("t1", "a.csv");
    store.addChip("t1", "dir/b.md");
    expect(store.chips("t1")).toEqual(["a.csv", "dir/b.md"]);
    expect(store.chips("t2")).toEqual([]);
    const content = store.contentFor("t1", "Compare these  ");
    expect(content).toBe(`Compare these\n\n${mentionMarker("a.csv")} ${mentionMarker("dir/b.md")}`);
    expect(store.forText("t1", content)).toEqual(["a.csv", "dir/b.md"]);
  });

  it("does not repeat a marker the text already holds and merges picks", () => {
    const store = new MentionStore();
    store.add("t1", "p.txt");
    store.addChip("t1", "a.csv");
    const text = `See ${mentionMarker("a.csv")} and ${mentionMarker("p.txt")}`;
    expect(store.contentFor("t1", text)).toBe(text);
    expect(store.forText("t1", text)).toEqual(["a.csv", "p.txt"]);
  });

  it("settles, clears, removes and moves chips", () => {
    const store = new MentionStore();
    store.addChip("new", "a.csv");
    store.move("new", "t1");
    expect(store.chips("new")).toEqual([]);
    expect(store.chips("t1")).toEqual(["a.csv"]);
    store.addChip("t1", "b.csv");
    store.settleSent("t1", ["a.csv"], "");
    expect(store.chips("t1")).toEqual(["b.csv"]);
    store.removeChip("t1", "b.csv");
    expect(store.chips("t1")).toEqual([]);
    store.addChip("t1", "c.csv");
    store.clear("t1");
    expect(store.chips("t1")).toEqual([]);
    expect(store.contentFor("t1", "hi")).toBe("hi");
  });
});
