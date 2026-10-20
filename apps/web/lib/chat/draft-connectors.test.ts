import { describe, expect, it, vi } from "vitest";
import { DraftConnectorStore } from "./draft-connectors";

describe("DraftConnectorStore (KOBE-451 review MEDIUM-3)", () => {
  it("keeps the off set, tells listeners on a change only, and is taken once", () => {
    const store = new DraftConnectorStore();
    const heard = vi.fn();
    store.subscribe(heard);
    store.set("a", false);
    store.set("a", false);
    store.set("b", false);
    store.set("b", true);
    expect([...store.snapshot()]).toEqual(["a"]);
    expect(heard).toHaveBeenCalledTimes(3);
    expect(store.take()).toEqual(["a"]);
    expect(store.take()).toEqual([]);
    expect(store.snapshot().size).toBe(0);
  });
});
