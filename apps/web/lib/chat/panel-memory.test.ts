import { describe, expect, it, vi } from "vitest";
import { ThreadsPanelMemory } from "./panel-memory";

describe("the Threads panel's memory (KOBE-536, TF12)", () => {
  it("starts on Current, remembers the node, keeps groups per node, tells folder changes", () => {
    const memory = new ThreadsPanelMemory();
    const folder = vi.fn();
    memory.onFolderChange(folder);
    expect(memory.node).toEqual({ kind: "current" });
    memory.flip("pinned");
    memory.choose({ kind: "folder", id: "f" });
    expect(folder).toHaveBeenCalledTimes(1);
    expect(memory.folderId).toBe("f");
    expect(memory.flipped("pinned")).toBe(false);
    memory.choose({ kind: "archived" });
    expect(memory.currentOpen).toBe(true);
    expect(folder).toHaveBeenCalledTimes(2);
    memory.choose({ kind: "current" });
    expect(memory.flipped("pinned")).toBe(true);
    expect(folder).toHaveBeenCalledTimes(2);
    memory.choose({ kind: "archived" });
    memory.setCurrentOpen(false);
    expect(memory.node).toEqual({ kind: "current" });
  });
});
