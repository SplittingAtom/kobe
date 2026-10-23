// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIN_CHECK_GAP_MS,
  PERIODIC_CHECK_MS,
  createBuildWatcher,
  fetchBuildId,
  isChunkLoadError,
  noteChunkLoadError,
  noteUnknownInput,
  setActiveWatcher,
  watchForNewBuild,
} from "./build-watcher";

/** KOBE-487 ac-2/3/5: when an open tab asks whether the web was redeployed, and what it concludes. */
function setup(served: () => string | undefined) {
  let now = 1_000_000;
  const fetchId = vi.fn(async () => served());
  const watcher = createBuildWatcher({ current: "old", fetchBuildId: fetchId, now: () => now });
  return { watcher, fetchId, advance: (ms: number) => (now += ms) };
}

afterEach(() => {
  setActiveWatcher(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createBuildWatcher", () => {
  it("stays quiet while the served build is the page's own", async () => {
    const { watcher, fetchId } = setup(() => "old");
    expect(await watcher.check("visible")).toBe(false);
    expect(watcher.isStale()).toBe(false);
    expect(fetchId).toHaveBeenCalledOnce();
  });

  it("turns stale on a different served build and tells its listeners once", async () => {
    const { watcher, fetchId } = setup(() => "new");
    const listener = vi.fn();
    watcher.subscribe(listener);
    expect(await watcher.check("periodic")).toBe(true);
    expect(await watcher.check("visible")).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(fetchId).toHaveBeenCalledOnce(); // stale is final: no more requests
  });

  it("asks at most once per gap, but the first check goes at once", async () => {
    const { watcher, fetchId, advance } = setup(() => "old");
    await watcher.check("visible");
    await watcher.check("unknown-input");
    expect(fetchId).toHaveBeenCalledOnce();
    advance(MIN_CHECK_GAP_MS);
    await watcher.check("visible");
    expect(fetchId).toHaveBeenCalledTimes(2);
  });

  it("shares one request between checks that overlap", async () => {
    const { watcher, fetchId } = setup(() => "new");
    const [a, b] = await Promise.all([watcher.check("visible"), watcher.check("chunk-error")]);
    expect([a, b]).toEqual([true, true]);
    expect(fetchId).toHaveBeenCalledOnce();
  });

  it("keeps the page on an unreachable endpoint, except after a failed chunk load", async () => {
    const { watcher, advance } = setup(() => undefined);
    expect(await watcher.check("visible")).toBe(false);
    advance(1);
    expect(await watcher.check("chunk-error")).toBe(true); // not throttled, and stale
  });

  it("does not call a failed chunk load stale while the same build is served", async () => {
    const { watcher } = setup(() => "old");
    expect(await watcher.check("chunk-error")).toBe(false);
  });
});

describe("fetchBuildId", () => {
  it("reads the endpoint without the cache", async () => {
    const fetchMock = vi.fn(async () => Response.json({ buildId: "b1" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchBuildId()).toBe("b1");
    expect(fetchMock).toHaveBeenCalledWith("/api/build", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("is undefined on a failed request or an unexpected body", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 502 }));
    expect(await fetchBuildId()).toBeUndefined();
    vi.stubGlobal("fetch", async () => Response.json({ build: 1 }));
    expect(await fetchBuildId()).toBeUndefined();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    expect(await fetchBuildId()).toBeUndefined();
  });
});

describe("isChunkLoadError", () => {
  it("knows the bundlers' and browsers' failed-chunk errors", () => {
    const named = Object.assign(new Error("Loading chunk 12 failed."), { name: "ChunkLoadError" });
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /x"))).toBe(
      true,
    );
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Failed to load chunk /_next/static/chunks/a.js"))).toBe(
      true,
    );
  });

  it("leaves other errors alone", () => {
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
    expect(isChunkLoadError("Loading chunk")).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("watchForNewBuild", () => {
  function started(served = "old") {
    const { watcher, fetchId } = setup(() => served);
    const check = vi.spyOn(watcher, "check");
    const stop = watchForNewBuild(window, watcher);
    return { watcher, fetchId, check, stop };
  }

  it("checks when the tab becomes visible or gains focus", () => {
    const { check, stop } = started();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(check.mock.calls).toEqual([["visible"], ["visible"]]);
    stop();
    window.dispatchEvent(new Event("focus"));
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("checks every ten minutes", () => {
    vi.useFakeTimers();
    const { check, stop } = started();
    vi.advanceTimersByTime(PERIODIC_CHECK_MS - 1);
    expect(check).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(check).toHaveBeenCalledWith("periodic");
    stop();
  });

  it("checks at once on a failed chunk load: a rejected import or a chunk script that failed", () => {
    const { check, stop } = started();
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = Object.assign(new Error("Loading chunk 3 failed."), {
      name: "ChunkLoadError",
    });
    window.dispatchEvent(rejection);
    expect(check.mock.calls).toEqual([["chunk-error"]]);
    // (happy-dom may also fail the load itself and fire its own error event.)
    const script = document.createElement("script");
    script.src = "/_next/static/chunks/app-123.js";
    document.head.append(script);
    script.dispatchEvent(new Event("error"));
    const calls = check.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(new Set(check.mock.calls.map((c) => c[0]))).toEqual(new Set(["chunk-error"]));
    const other = document.createElement("div");
    document.body.append(other);
    other.dispatchEvent(new Event("error"));
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("boom") }));
    expect(check).toHaveBeenCalledTimes(calls);
    stop();
  });

  it("is what noteUnknownInput asks while it is the active watcher", () => {
    const { watcher } = setup(() => "old");
    const check = vi.spyOn(watcher, "check");
    noteUnknownInput(); // none active: nothing to ask
    setActiveWatcher(watcher);
    noteUnknownInput();
    expect(check.mock.calls).toEqual([["unknown-input"]]);
  });
});

describe("noteChunkLoadError", () => {
  it("makes the active watcher stale at once, without asking", () => {
    const { watcher, fetchId } = setup(() => "old");
    const listener = vi.fn();
    watcher.subscribe(listener);
    setActiveWatcher(watcher);
    noteChunkLoadError();
    expect(watcher.isStale()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(fetchId).not.toHaveBeenCalled();
  });
});
