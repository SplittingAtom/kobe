import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileChange } from "@kobe/protocol";
import type { EventSourceLike } from "../chat/stream";
import { WorkspaceChangeFeed, workspaceChangesUrl } from "./remote-changes";

const TEAM = "0b7c3f8e-1d2a-4c5b-9e6f-7a8b9c0d1e2f";
const SHA = (c: string) => c.repeat(64);

class Source implements EventSourceLike {
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.readyState = 2;
  }
  send(type: string, change: unknown) {
    const message = new MessageEvent<string>(type, { data: JSON.stringify(change) });
    for (const l of this.listeners.get(type) ?? []) l(message);
  }
  end() {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }
}

const change = (path: string, rev: number, sha: string | null): WorkspaceFileChange => ({
  path,
  sha256: sha,
  rev,
  actor: { kind: "user", name: "Ann" },
  at: "2026-10-23T10:00:00.000Z",
});

let sources: Source[];
let feed: WorkspaceChangeFeed;
beforeEach(() => {
  vi.useFakeTimers();
  sources = [];
  feed = new WorkspaceChangeFeed({
    teamId: TEAM,
    debounceMs: 100,
    reopenDelaysMs: [1_000, 5_000],
    eventSource: (url) => {
      const s = new Source(url);
      sources.push(s);
      return s;
    },
  });
});
afterEach(() => {
  feed.dispose();
  vi.useRealTimers();
});

const paths = (s: Source | undefined) =>
  new URL(s?.url ?? "", "http://x").searchParams.getAll("path");

describe("WorkspaceChangeFeed (KOBE-496)", () => {
  it("opens one stream for the whole open tab set, debounced and sorted", () => {
    const offB = feed.watch("b.md");
    feed.watch("a.md");
    feed.watch("a.md"); // a second tab of the same file
    expect(sources).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(sources).toHaveLength(1);
    expect(paths(sources[0])).toEqual(["a.md", "b.md"]);
    expect(new URL(sources[0]?.url ?? "", "http://x").searchParams.get("team")).toBe(TEAM);
    offB();
    vi.advanceTimersByTime(100);
    expect(sources[0]?.readyState).toBe(2);
    expect(paths(sources[1])).toEqual(["a.md"]);
  });

  it("keeps the latest message per path, a lower revision included, and ignores others", () => {
    feed.watch("a.md");
    vi.advanceTimersByTime(100);
    const listener = vi.fn();
    feed.subscribe(listener);
    const s = sources[0];
    s?.send("file.state", change("a.md", 3, SHA("a")));
    s?.send("file.changed", change("a.md", 5, SHA("b")));
    // After a reconnect the state is the truth: deleted and collected (rev 0), or restarted.
    s?.send("file.state", change("a.md", 0, null));
    s?.send("file.changed", change("z.md", 9, SHA("z"))); // not watched
    s?.send("file.changed", { path: "a.md" }); // malformed
    expect(feed.get("a.md")).toEqual(expect.objectContaining({ rev: 0, sha256: null }));
    expect(feed.get("z.md")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("keeps a change whose actor name the contract refuses, without the name", () => {
    feed.watch("a.md");
    vi.advanceTimersByTime(100);
    sources[0]?.send("file.changed", {
      ...change("a.md", 2, SHA("a")),
      actor: { kind: "user", name: "" },
    });
    expect(feed.get("a.md")?.actor).toEqual({ kind: "user", name: null });
    sources[0]?.send("file.changed", {
      ...change("a.md", 3, SHA("b")),
      actor: { kind: "x", name: "" },
    });
    expect(feed.get("a.md")?.rev).toBe(2);
  });

  it("says which tabs are past the path limit, and follows the first 32", () => {
    const paths = Array.from({ length: 33 }, (_, i) => `f${String(i).padStart(2, "0")}.md`);
    for (const p of paths) feed.watch(p);
    vi.advanceTimersByTime(100);
    expect(new URL(sources[0]?.url ?? "", "http://x").searchParams.getAll("path")).toHaveLength(32);
    expect(feed.overflow("f00.md")).toBe(false);
    expect(feed.overflow("f32.md")).toBe(true);
    expect(feed.overflow("not-open.md")).toBe(false);
  });

  it("closes when no tab is open and forgets the paths", () => {
    const off = feed.watch("a.md");
    vi.advanceTimersByTime(100);
    sources[0]?.send("file.state", change("a.md", 1, SHA("a")));
    off();
    off(); // idempotent
    vi.advanceTimersByTime(100);
    expect(sources[0]?.readyState).toBe(2);
    expect(sources).toHaveLength(1);
    expect(feed.get("a.md")).toBeUndefined();
  });

  it("re-opens a stream the server ended after a bounded backoff", () => {
    feed.watch("a.md");
    vi.advanceTimersByTime(100);
    sources[0]?.end();
    vi.advanceTimersByTime(999);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);
    sources[1]?.end();
    vi.advanceTimersByTime(4_999);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);
  });

  it("stops for good when the probe says the team changed, instead of retrying forever", async () => {
    const probe = vi.fn(async () => false);
    const stopping = new WorkspaceChangeFeed({
      teamId: TEAM,
      debounceMs: 100,
      reopenDelaysMs: [1_000],
      probe,
      eventSource: (url) => {
        const s = new Source(url);
        sources.push(s);
        return s;
      },
    });
    stopping.watch("a.md");
    vi.advanceTimersByTime(100);
    expect(sources).toHaveLength(1);
    sources[0]?.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(stopping.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    stopping.watch("b.md");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources).toHaveLength(1);
    stopping.dispose();
  });

  it("re-opens after the probe says the team is still the same", async () => {
    const again = new WorkspaceChangeFeed({
      teamId: TEAM,
      debounceMs: 100,
      reopenDelaysMs: [1_000],
      probe: async () => true,
      eventSource: (url) => {
        const s = new Source(url);
        sources.push(s);
        return s;
      },
    });
    again.watch("a.md");
    vi.advanceTimersByTime(100);
    sources[0]?.end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources).toHaveLength(2);
    again.dispose();
  });

  it("builds the contract's URL", () => {
    expect(workspaceChangesUrl(TEAM, ["a b.md", "c/d.md"])).toBe(
      `/v1/workspace/changes?team=${TEAM}&path=a+b.md&path=c%2Fd.md`,
    );
  });
});
