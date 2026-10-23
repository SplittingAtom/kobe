import { describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../api/client";
import type { FilesApi, FolderListing } from "./api";
import { fileVersion, minimalChange, VersionWatch, type VersionCheck } from "./outside-change";

/** KOBE-491: the open tab's cheap version check, its bounded watcher and the in-place reload. */

function entry(path: string, sha256?: string) {
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    type: "file" as const,
    sizeBytes: 1,
    mtime: "2026-10-23T00:00:00Z",
    source: "synced" as const,
    area: "workspace" as const,
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

function listApi(pages: Record<string, ApiResult<FolderListing>>) {
  const calls: { path: string; cursor: string | undefined }[] = [];
  const list = vi.fn(async (path: string, cursor?: string) => {
    calls.push({ path, cursor });
    const page = pages[`${path}|${cursor ?? ""}`];
    if (!page) throw new Error(`unexpected list ${path} ${cursor}`);
    return page;
  });
  return { api: { list } as unknown as FilesApi, calls };
}

const ok = (data: FolderListing): ApiResult<FolderListing> => ({ ok: true, status: 200, data });

describe("fileVersion", () => {
  it("reads the version from the parent folder's listing, not the file", async () => {
    const { api, calls } = listApi({
      "reports|": ok({ path: "reports", entries: [entry("reports/a.md", "aaa")] }),
    });
    expect(await fileVersion(api, "reports/a.md")).toEqual({ kind: "version", sha256: "aaa" });
    expect(calls).toEqual([{ path: "reports", cursor: undefined }]);
  });

  it("lists the root for a top-level file and follows a few pages", async () => {
    const { api } = listApi({
      "|": ok({ path: "", entries: [entry("b.md", "b")], nextCursor: "c1" }),
      "|c1": ok({ path: "", entries: [entry("a.md", "a")] }),
    });
    expect(await fileVersion(api, "a.md")).toEqual({ kind: "version", sha256: "a" });
  });

  it("says gone when the file or its folder is no longer listed", async () => {
    const { api } = listApi({
      "x|": ok({ path: "x", entries: [entry("x/other.md", "o")] }),
      "y|": { ok: false, error: { status: 404, code: "not_found", message: "gone" } },
    });
    expect(await fileVersion(api, "x/a.md")).toEqual({ kind: "gone" });
    expect(await fileVersion(api, "y/a.md")).toEqual({ kind: "gone" });
  });

  it("is unknown on other errors, a missing version or too many pages", async () => {
    const pages: Record<string, ApiResult<FolderListing>> = {
      "e|": { ok: false, error: { status: 503, code: "unavailable", message: "no" } },
      "n|": ok({ path: "n", entries: [entry("n/a.md")] }),
    };
    for (let i = 0; i < 5; i += 1) {
      pages[`p|${i === 0 ? "" : `c${i}`}`] = ok({
        path: "p",
        entries: [entry(`p/z${i}.md`, "z")],
        nextCursor: `c${i + 1}`,
      });
    }
    const { api, calls } = listApi(pages);
    expect(await fileVersion(api, "e/a.md")).toEqual({ kind: "unknown" });
    expect(await fileVersion(api, "n/a.md")).toEqual({ kind: "unknown" });
    expect(await fileVersion(api, "p/a.md")).toEqual({ kind: "unknown" });
    expect(calls.filter((c) => c.path === "p").length).toBeLessThanOrEqual(3);
  });
});

describe("VersionWatch", () => {
  /** Waits resolve only when the test says so, to observe each step. */
  function harness(results: VersionCheck[], known = "v1") {
    let current = known;
    const waits: { ms: number; resolve: () => void }[] = [];
    const wait = (ms: number) => new Promise<void>((resolve) => waits.push({ ms, resolve }));
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: (() => void)[] = [];
    const check = vi.fn(async (): Promise<VersionCheck> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return results.shift() ?? { kind: "unknown" };
    });
    const changed = vi.fn();
    const watch = new VersionWatch({ check, known: () => current, onChange: changed, wait });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return {
      watch,
      check,
      changed,
      waits,
      releases,
      flush,
      maxInFlight: () => maxInFlight,
      setKnown: (v: string) => (current = v),
    };
  }

  it("checks at once on a hint without delays and reports a new version", async () => {
    const h = harness([{ kind: "version", sha256: "v2" }]);
    h.watch.hint([0]);
    await h.flush();
    expect(h.check).toHaveBeenCalledTimes(1);
    h.releases.shift()?.();
    await h.flush();
    expect(h.changed).toHaveBeenCalledWith({ kind: "version", sha256: "v2" });
  });

  it("retries on its schedule while nothing changed, and stops at the first change", async () => {
    const h = harness([
      { kind: "version", sha256: "v1" },
      { kind: "version", sha256: "v2" },
    ]);
    h.watch.hint([0, 100, 200, 400]);
    await h.flush();
    h.releases.shift()?.();
    await h.flush();
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.waits.map((w) => w.ms)).toEqual([100]);
    h.waits.shift()?.resolve();
    await h.flush();
    h.releases.shift()?.();
    await h.flush();
    expect(h.changed).toHaveBeenCalledWith({ kind: "version", sha256: "v2" });
    expect(h.waits).toHaveLength(0); // no more retries
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it("keeps one check in flight: a new hint waits for it and replaces the old schedule", async () => {
    const h = harness([
      { kind: "version", sha256: "v1" },
      { kind: "version", sha256: "v3" },
    ]);
    h.watch.hint([0, 100]);
    await h.flush();
    h.watch.hint([0]);
    h.watch.hint([0]);
    await h.flush();
    expect(h.check).toHaveBeenCalledTimes(1);
    h.releases.shift()?.();
    await h.flush();
    expect(h.check).toHaveBeenCalledTimes(2);
    h.releases.shift()?.();
    await h.flush();
    expect(h.maxInFlight()).toBe(1);
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(h.waits).toHaveLength(0); // the first schedule's retry never ran
  });

  it("ignores a result when the tab's own version moved during the check (its save)", async () => {
    const h = harness([{ kind: "version", sha256: "v0-old" }]);
    h.watch.hint([0]);
    await h.flush();
    h.setKnown("v2-saved");
    h.releases.shift()?.();
    await h.flush();
    expect(h.changed).not.toHaveBeenCalled();
  });

  it("reports gone, ignores unknown, and does nothing after dispose", async () => {
    const h = harness([{ kind: "unknown" }, { kind: "gone" }]);
    h.watch.hint([0]);
    await h.flush();
    h.releases.shift()?.();
    await h.flush();
    expect(h.changed).not.toHaveBeenCalled();
    h.watch.hint([0]);
    await h.flush();
    h.releases.shift()?.();
    await h.flush();
    expect(h.changed).toHaveBeenCalledWith({ kind: "gone" });
    h.watch.dispose();
    h.watch.hint([0]);
    await h.flush();
    expect(h.check).toHaveBeenCalledTimes(2);
  });
});

describe("VersionWatch: focus and dispose (review)", () => {
  it("a one-shot hint never cancels a pending schedule, and runs when none is pending", async () => {
    const waits: { ms: number; resolve: () => void }[] = [];
    const wait = (ms: number) => new Promise<void>((resolve) => waits.push({ ms, resolve }));
    const results: VersionCheck[] = [
      { kind: "version", sha256: "v1" },
      { kind: "version", sha256: "v2" },
      { kind: "version", sha256: "v2" },
    ];
    const check = vi.fn(async (): Promise<VersionCheck> => results.shift() ?? { kind: "unknown" });
    const changed = vi.fn();
    let known = "v1";
    const watch = new VersionWatch({ check, known: () => known, onChange: changed, wait });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    watch.hint([0, 1_500, 3_000]);
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
    watch.hint([0], { oneShot: true }); // focus mid-schedule: skipped
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
    waits.shift()?.resolve(); // the schedule's retry still runs and finds the change
    await flush();
    expect(changed).toHaveBeenCalledWith({ kind: "version", sha256: "v2" });
    known = "v2";
    watch.hint([0], { oneShot: true }); // nothing pending now: it checks
    await flush();
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("dispose clears pending timers and aborts the in-flight listing", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const check = vi.fn(
        (signal: AbortSignal) =>
          new Promise<VersionCheck>((resolve) => {
            signals.push(signal);
            signal.addEventListener("abort", () => resolve({ kind: "unknown" }));
          }),
      );
      const watch = new VersionWatch({ check, known: () => "v1", onChange: vi.fn() });
      watch.hint([0]);
      await vi.advanceTimersByTimeAsync(0);
      expect(signals[0]?.aborted).toBe(false);
      watch.dispose();
      expect(signals[0]?.aborted).toBe(true);

      const second = new VersionWatch({ check, known: () => "v1", onChange: vi.fn() });
      second.hint([5_000]);
      expect(vi.getTimerCount()).toBe(1);
      second.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fileVersion passes the signal to the listing", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: { path: "", entries: [entry("a.md", "a")] },
    }));
    const signal = new AbortController().signal;
    await fileVersion({ list } as unknown as FilesApi, "a.md", signal);
    expect(list).toHaveBeenCalledWith("", undefined, signal);
  });
});

describe("minimalChange", () => {
  it("replaces only the differing middle, so the cursor and scroll outside it stay", () => {
    expect(minimalChange("a\nb\nc\n", "a\nB\nc\n")).toEqual({ from: 2, to: 3, insert: "B" });
    expect(minimalChange("abc", "abc")).toBeNull();
    expect(minimalChange("abc", "abXc")).toEqual({ from: 2, to: 2, insert: "X" });
    expect(minimalChange("aaa", "aa")).toEqual({ from: 2, to: 3, insert: "" });
    expect(minimalChange("", "new")).toEqual({ from: 0, to: 0, insert: "new" });
  });
});
