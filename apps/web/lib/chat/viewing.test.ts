import { describe, expect, it, vi } from "vitest";
import { ViewingStore } from "./viewing";

describe("the viewed file (KOBE-463, FE7)", () => {
  it("is the file tab on screen until the member removes the chip, and a new file shows again", () => {
    const store = new ViewingStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.current()).toBeUndefined();
    store.show("notes.md");
    expect(store.current()).toBe("notes.md");
    store.dismiss();
    expect(store.current()).toBeUndefined();
    store.show("notes.md"); // still the same file: stays removed
    expect(store.current()).toBeUndefined();
    store.show("data.csv");
    expect(store.current()).toBe("data.csv");
    store.hide("notes.md"); // another tab's leaving does not clear this one
    expect(store.current()).toBe("data.csv");
    store.hide("data.csv");
    expect(store.current()).toBeUndefined();
    expect(listener).toHaveBeenCalled();
  });

  it("a closed tab forgets the removal: opening the file again shows the chip", () => {
    const store = new ViewingStore();
    store.show("notes.md");
    store.dismiss();
    store.closed("notes.md");
    expect(store.current()).toBeUndefined();
    store.show("notes.md");
    expect(store.current()).toBe("notes.md");
    // Only a switch away (not a close) keeps it removed.
    store.dismiss();
    store.hide("notes.md");
    store.show("notes.md");
    expect(store.current()).toBeUndefined();
  });

  it("is sent as `viewing: {path}`, or not at all", () => {
    const store = new ViewingStore();
    expect(store.body()).toBeUndefined();
    store.show("a/b.md");
    expect(store.body()).toEqual({ path: "a/b.md" });
  });
});
