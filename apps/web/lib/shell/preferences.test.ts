// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyArtifactWidth,
  createPreferencesSaver,
  loadPreferences,
  PREFERENCES_PATH,
  readPreferences,
  spaceRightOfRail,
  toWire,
} from "./preferences";

/** KOBE-202 (CE8): layout preferences, applied when they still fit and saved debounced. */
describe("apply (ac-3)", () => {
  it("applies a width that fits beside the conversation's floor, else the default", () => {
    expect(applyArtifactWidth(600, 1000)).toBe(600); // 600 + 400 = 1000
    expect(applyArtifactWidth(601, 1000)).toBeNull(); // wider than the space now holds
    expect(applyArtifactWidth(359, 2000)).toBeNull(); // under the column's floor
    expect(applyArtifactWidth(360, 700)).toBeNull(); // both floors don't fit
    expect(applyArtifactWidth(null, 1000)).toBeNull();
    expect(applyArtifactWidth(undefined, 1000)).toBeNull();
  });
});

describe("wire", () => {
  it("reads the camel-cased response and drops malformed values", () => {
    expect(
      readPreferences({
        preferences: { railCollapsed: true, threadsShare: 0.4, artifactWidth: 720 },
      }),
      // The Threads share (KOBE-198) is no longer read since KOBE-453.
    ).toEqual({ railCollapsed: true, artifactWidth: 720 });
    expect(readPreferences({ preferences: { artifactWidth: null } })).toEqual({
      artifactWidth: null,
    });
    expect(
      readPreferences({
        preferences: { railCollapsed: "yes", threadsShare: "0.4", artifactWidth: 1.5 },
      }),
    ).toEqual({});
    expect(readPreferences(null)).toEqual({});
    expect(readPreferences({ preferences: [] })).toEqual({});
    // KOBE-208: the Detail toggle.
    expect(readPreferences({ preferences: { detailExpanded: true } })).toEqual({
      detailExpanded: true,
    });
    expect(readPreferences({ preferences: { detailExpanded: 1 } })).toEqual({});
    // KOBE-305: the rail's width.
    expect(readPreferences({ preferences: { railWidth: 360 } })).toEqual({ railWidth: 360 });
    expect(readPreferences({ preferences: { railWidth: null } })).toEqual({ railWidth: null });
    expect(readPreferences({ preferences: { railWidth: 9000 } })).toEqual({});
    expect(readPreferences({ preferences: { railPanels: "files" } })).toEqual({
      railPanels: "files",
    });
    expect(readPreferences({ preferences: { railPanels: "none" } })).toEqual({});
    // KOBE-448: the rail section's last tab.
    expect(readPreferences({ preferences: { railTab: "apps" } })).toEqual({ railTab: "apps" });
    expect(readPreferences({ preferences: { railTab: "threads" } })).toEqual({});
    // KOBE-459: the Workbench editor rail's width.
    expect(readPreferences({ preferences: { workbenchEditorWidth: 640 } })).toEqual({
      workbenchEditorWidth: 640,
    });
    expect(readPreferences({ preferences: { workbenchEditorWidth: 12 } })).toEqual({});
    // KOBE-460: the rail's picker, an app id or null.
    const picker = "b".repeat(64);
    expect(readPreferences({ preferences: { railPicker: picker } })).toEqual({
      railPicker: picker,
    });
    expect(readPreferences({ preferences: { railPicker: null } })).toEqual({ railPicker: null });
    expect(readPreferences({ preferences: { railPicker: "x" } })).toEqual({});
  });

  it("writes only the keys that changed, in wire casing", () => {
    expect(toWire({ railCollapsed: false })).toEqual({ rail_collapsed: false });
    expect(toWire({ railWidth: 360, artifactWidth: null })).toEqual({
      rail_width: 360,
      artifact_width: null,
    });
    expect(toWire({ detailExpanded: false })).toEqual({ detail_expanded: false });
    expect(toWire({ railWidth: 400 })).toEqual({ rail_width: 400 });
    expect(toWire({ railWidth: null })).toEqual({ rail_width: null });
    expect(toWire({ railPanels: "threads" })).toEqual({ rail_panels: "threads" });
    expect(toWire({ railTab: "apps" })).toEqual({ rail_tab: "apps" });
    expect(toWire({ workbenchEditorWidth: null })).toEqual({ workbench_editor_width: null });
    expect(toWire({ railPicker: null })).toEqual({ rail_picker: null });
    expect(toWire({})).toEqual({});
  });
});

describe("load", () => {
  it("logs a failure and returns the defaults", async () => {
    const log = vi.fn();
    const fetchFn = vi.fn(async () => Response.json({ code: "server_error" }, { status: 500 }));
    expect(await loadPreferences(fetchFn, log)).toEqual({});
    expect(log).toHaveBeenCalledOnce();
  });

  it("survives a network failure", async () => {
    const log = vi.fn();
    const fetchFn = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(await loadPreferences(fetchFn, log)).toEqual({});
    expect(log).toHaveBeenCalledOnce();
  });
});

describe("save", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const putFetch = () =>
    vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ preferences: {} }),
    );
  const bodies = (fetchFn: ReturnType<typeof putFetch>) =>
    fetchFn.mock.calls.map(([input, init]) => ({
      path: String(input),
      method: init?.method,
      body: JSON.parse(String(init?.body)) as unknown,
    }));

  it("debounces changes into one PUT of the keys that changed", async () => {
    const fetchFn = putFetch();
    const saver = createPreferencesSaver({ fetchFn, delayMs: 500 });
    saver.save({ railWidth: 330 });
    saver.save({ railWidth: 320 });
    await vi.advanceTimersByTimeAsync(400);
    saver.save({ railCollapsed: true });
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(bodies(fetchFn)).toEqual([
      { path: PREFERENCES_PATH, method: "PUT", body: { rail_width: 320, rail_collapsed: true } },
    ]);
  });

  it("flushes what is queued at once, and nothing when nothing is", async () => {
    const fetchFn = putFetch();
    const saver = createPreferencesSaver({ fetchFn, delayMs: 500 });
    saver.flush();
    expect(fetchFn).not.toHaveBeenCalled();
    saver.save({ artifactWidth: 640 });
    saver.flush();
    expect(bodies(fetchFn)).toEqual([
      { path: PREFERENCES_PATH, method: "PUT", body: { artifact_width: 640 } },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("lets a flush outlive the page when asked (keepalive)", () => {
    const fetchFn = putFetch();
    const saver = createPreferencesSaver({ fetchFn, delayMs: 500 });
    saver.save({ railCollapsed: true });
    saver.flush({ keepalive: true });
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: "PUT", keepalive: true });
    saver.save({ railCollapsed: false });
    saver.flush();
    expect(fetchFn.mock.calls[1]?.[1]?.keepalive).toBeUndefined();
  });

  it("logs a failed save and never throws", async () => {
    const log = vi.fn();
    const fetchFn = vi.fn(async () => Response.json({ code: "x" }, { status: 400 }));
    const saver = createPreferencesSaver({ fetchFn, delayMs: 10, log });
    saver.save({ railCollapsed: false });
    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
  });
});

describe("spaceRightOfRail", () => {
  const grid = (artifact: number, conversation: number) => {
    const el = document.createElement("div");
    for (const [name, width] of [
      ["rail", 280],
      ["artifact", artifact],
      ["conversation", conversation],
    ] as const) {
      const child = document.createElement("div");
      child.setAttribute("data-shell-region", name);
      child.getBoundingClientRect = () => ({ width }) as DOMRect;
      el.append(child);
    }
    return el;
  };

  it("is the artifact column and the conversation together, as laid out", () => {
    expect(spaceRightOfRail(grid(0, 1000))).toBe(1000);
    expect(spaceRightOfRail(grid(400, 600))).toBe(1000);
  });

  it("is null when the grid isn't there or not laid out", () => {
    expect(spaceRightOfRail(null)).toBeNull();
    expect(spaceRightOfRail(grid(0, 0))).toBeNull();
    expect(spaceRightOfRail(document.createElement("div"))).toBeNull();
  });
});
