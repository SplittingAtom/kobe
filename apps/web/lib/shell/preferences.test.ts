// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyArtifactWidth,
  applyRailCollapsed,
  applyThreadsShare,
  createPreferencesSaver,
  loadPreferences,
  PREFERENCES_PATH,
  readPreferences,
  spaceRightOfRail,
  toWire,
} from "./preferences";

/** KOBE-202 (CE8): layout preferences, applied when they still fit and saved debounced. */
describe("apply (ac-3)", () => {
  it("keeps the narrow-screen default: the rail starts collapsed whatever is stored", () => {
    expect(applyRailCollapsed(false, true)).toBe(true);
    expect(applyRailCollapsed(undefined, true)).toBe(true);
    expect(applyRailCollapsed(true, false)).toBe(true);
    expect(applyRailCollapsed(false, false)).toBe(false);
    expect(applyRailCollapsed(undefined, false)).toBeNull();
  });

  it("applies a share within the rail's bounds and ignores one outside", () => {
    expect(applyThreadsShare(0.45)).toBe(0.45);
    expect(applyThreadsShare(0.2)).toBe(0.2);
    expect(applyThreadsShare(0.8)).toBe(0.8);
    expect(applyThreadsShare(0.85)).toBeNull();
    expect(applyThreadsShare(0.1)).toBeNull();
    expect(applyThreadsShare(Number.NaN)).toBeNull();
    expect(applyThreadsShare(undefined)).toBeNull();
  });

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
    ).toEqual({ railCollapsed: true, threadsShare: 0.4, artifactWidth: 720 });
    expect(readPreferences({ preferences: { artifactWidth: null } })).toEqual({
      artifactWidth: null,
    });
    expect(
      readPreferences({
        preferences: { railCollapsed: "yes", threadsShare: "0.4", artifactWidth: 1.5 },
      }),
    ).toEqual({});
    // Read with the protocol's reader: a share outside the rail's bounds is dropped, not clamped.
    expect(readPreferences({ preferences: { threadsShare: 0.95 } })).toEqual({});
    expect(readPreferences(null)).toEqual({});
    expect(readPreferences({ preferences: [] })).toEqual({});
  });

  it("writes only the keys that changed, in wire casing", () => {
    expect(toWire({ railCollapsed: false })).toEqual({ rail_collapsed: false });
    expect(toWire({ threadsShare: 0.5, artifactWidth: null })).toEqual({
      threads_share: 0.5,
      artifact_width: null,
    });
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
    saver.save({ threadsShare: 0.55 });
    saver.save({ threadsShare: 0.5 });
    await vi.advanceTimersByTimeAsync(400);
    saver.save({ railCollapsed: true });
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(bodies(fetchFn)).toEqual([
      { path: PREFERENCES_PATH, method: "PUT", body: { threads_share: 0.5, rail_collapsed: true } },
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
