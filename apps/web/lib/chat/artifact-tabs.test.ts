// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateTab,
  clampArtifactWidth,
  closeTab,
  MAX_TABS,
  maxArtifactWidth,
  NO_TABS,
  openTab,
  readTabs,
  retainTabs,
  retargetFileTabs,
  tabsKey,
  writeTabs,
} from "./artifact-tabs";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C] = [id(1), id(2), id(3)];
const F = "file:notes/todo list.md";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("tab state", () => {
  it("opens in order of opening, re-opening only activates", () => {
    const tabs = openTab(openTab(openTab(NO_TABS, A), B), C);
    expect(tabs).toEqual({ open: [A, B, C], active: C });
    expect(openTab(tabs, A)).toEqual({ open: [A, B, C], active: A });
    expect(activateTab(tabs, B).active).toBe(B);
    expect(activateTab(tabs, id(9))).toBe(tabs);
  });

  it("closing the active tab activates its right neighbour, else its left", () => {
    const tabs = { open: [A, B, C], active: B };
    expect(closeTab(tabs, B)).toEqual({ open: [A, C], active: C });
    expect(closeTab({ open: [A, B], active: B }, B)).toEqual({ open: [A], active: A });
    expect(closeTab(tabs, A)).toEqual({ open: [B, C], active: B });
    expect(closeTab({ open: [A], active: A }, A)).toEqual(NO_TABS);
  });

  it("keeps at most MAX_TABS, closing the oldest", () => {
    let tabs = NO_TABS;
    for (let n = 1; n <= MAX_TABS + 2; n += 1) tabs = openTab(tabs, id(n));
    expect(tabs.open).toHaveLength(MAX_TABS);
    expect(tabs.open[0]).toBe(id(3));
  });

  it("drops artifacts that no longer exist", () => {
    const tabs = { open: [A, B, C], active: B };
    expect(retainTabs(tabs, new Set([A, B, C]))).toBe(tabs);
    expect(retainTabs(tabs, new Set([A, C]))).toEqual({ open: [A, C], active: C });
    expect(retainTabs(tabs, new Set())).toEqual(NO_TABS);
  });

  it("leaves file tabs to the file viewer (KOBE-268): the artifact list never drops them", () => {
    const tabs = { open: [A, F, B], active: F };
    expect(retainTabs(tabs, new Set([B]))).toEqual({ open: [F, B], active: F });
  });
});

describe("moved files (KOBE-304)", () => {
  it("file tabs of a moved file or folder follow it, in place, keeping the active one", () => {
    const tabs = { open: [A, F, "file:notes/b.md", "file:other.md"], active: F };
    expect(retargetFileTabs(tabs, "notes", "archive/notes")).toEqual({
      open: [A, "file:archive/notes/todo list.md", "file:archive/notes/b.md", "file:other.md"],
      active: "file:archive/notes/todo list.md",
    });
    expect(retargetFileTabs(tabs, "other.md", "renamed.md").open.at(-1)).toBe("file:renamed.md");
    // Untouched: the same value (no re-render, no storage write).
    expect(retargetFileTabs(tabs, "note", "x")).toBe(tabs);
    // A tab that would duplicate an open one merges into it.
    const dup = { open: ["file:a.md", "file:b.md"], active: "file:a.md" };
    expect(retargetFileTabs(dup, "a.md", "b.md")).toEqual({
      open: ["file:b.md"],
      active: "file:b.md",
    });
  });
});

describe("storage", () => {
  const key = tabsKey("team", "thread");

  it("round-trips and forgets an empty set", () => {
    writeTabs(key, { open: [A, B], active: A });
    expect(readTabs(key)).toEqual({ open: [A, B], active: A });
    writeTabs(key, NO_TABS);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it.each([
    ["not json", "{oops"],
    ["null", "null"],
    ["a number", "42"],
    ["no open list", JSON.stringify({ active: A })],
    ["open not a list", JSON.stringify({ open: A, active: A })],
  ])("reads garbled data (%s) as no tabs", (_label, raw) => {
    localStorage.setItem(key, raw);
    expect(readTabs(key)).toEqual(NO_TABS);
  });

  it("keeps only artifact ids, once each, and a valid active tab", () => {
    localStorage.setItem(key, JSON.stringify({ open: [A, 7, "../x", A, B, null], active: "nope" }));
    expect(readTabs(key)).toEqual({ open: [A, B], active: B });
  });

  it("keeps file tabs with valid workspace paths beside artifact tabs (KOBE-268)", () => {
    const open = [A, F, "file:", "file:/etc/x", "file:a/../b", F, "file:x.csv"];
    localStorage.setItem(key, JSON.stringify({ open, active: F }));
    expect(readTabs(key)).toEqual({ open: [A, F, "file:x.csv"], active: F });
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readTabs(key)).toEqual(NO_TABS);
    expect(() => writeTabs(key, { open: [A], active: A })).not.toThrow();
  });
});

describe("width floors (CE7)", () => {
  it("holds the artifact floor (360) and the conversation floor (400)", () => {
    expect(clampArtifactWidth(100, 1000)).toBe(360);
    expect(clampArtifactWidth(900, 1000)).toBe(600);
    expect(clampArtifactWidth(480.4, 1000)).toBe(480);
    expect(maxArtifactWidth(1000)).toBe(600);
  });

  it("keeps the artifact floor when both don't fit, and defaults to half for junk", () => {
    expect(clampArtifactWidth(500, 700)).toBe(360);
    expect(clampArtifactWidth(Number.NaN, 1000)).toBe(500);
  });
});
