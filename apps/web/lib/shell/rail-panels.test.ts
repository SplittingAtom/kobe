import { describe, expect, it } from "vitest";
import { isLastPanel, shows, withPanel } from "./rail-panels";

/** KOBE-419: the rail's panels, Threads, Files or both; never none. */
describe("rail panels", () => {
  it("says which panels show", () => {
    expect([shows("both", "threads"), shows("both", "files")]).toEqual([true, true]);
    expect([shows("threads", "threads"), shows("threads", "files")]).toEqual([true, false]);
    expect([shows("files", "threads"), shows("files", "files")]).toEqual([false, true]);
  });

  it("turns a panel on or off, but never the last one off", () => {
    expect(withPanel("both", "threads", false)).toBe("files");
    expect(withPanel("both", "files", false)).toBe("threads");
    expect(withPanel("threads", "files", true)).toBe("both");
    expect(withPanel("files", "threads", true)).toBe("both");
    expect(withPanel("threads", "threads", false)).toBe("threads");
    expect(withPanel("files", "files", false)).toBe("files");
    expect(withPanel("both", "files", true)).toBe("both");
  });

  it("knows the last panel on", () => {
    expect(isLastPanel("both", "threads")).toBe(false);
    expect(isLastPanel("threads", "threads")).toBe(true);
    expect(isLastPanel("threads", "files")).toBe(false);
    expect(isLastPanel("files", "files")).toBe(true);
  });
});
