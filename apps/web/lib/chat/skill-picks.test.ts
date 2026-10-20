import { describe, expect, it, vi } from "vitest";
import { SkillPickStore } from "./skill-picks";

describe("SkillPickStore (KOBE-451)", () => {
  it("keeps one skill per draft, tells listeners, clears and moves", () => {
    const store = new SkillPickStore();
    const heard = vi.fn();
    const stop = store.subscribe(heard);
    store.set("new", "pdf-report");
    store.set("new", "pdf-report");
    expect(heard).toHaveBeenCalledTimes(1);
    store.set("new", "charts");
    expect(store.get("new")).toBe("charts");
    store.move("new", "t-1");
    expect([store.get("new"), store.get("t-1")]).toEqual([undefined, "charts"]);
    store.clear("t-1");
    expect(store.get("t-1")).toBeUndefined();
    stop();
    store.set("x", "y");
    expect(heard).toHaveBeenCalledTimes(4);
  });
});
