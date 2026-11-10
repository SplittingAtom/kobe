import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSourceLike } from "../chat/stream";
import { must } from "../testing/must";
import { WorkspaceEventFeed, workspaceEventsUrl, type WorkspaceMoved } from "./workspace-events";

const TEAM = "0b7c3f8e-1d2a-4c5b-9e6f-7a8b9c0d1e2f";

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
  send(type: string, data: unknown) {
    const message = new MessageEvent<string>(type, { data: JSON.stringify(data) });
    for (const l of this.listeners.get(type) ?? []) l(message);
  }
  end() {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }
}

const src = (i: number) => must(sources[i]);
const v = (files_rev: number, projects_rev = "a") => ({ files_rev, projects_rev });

let sources: Source[];
let probe: () => Promise<boolean>;
let feed: WorkspaceEventFeed;
let heard: WorkspaceMoved[];
beforeEach(() => {
  vi.useFakeTimers();
  sources = [];
  heard = [];
  probe = () => Promise.resolve(true);
  feed = new WorkspaceEventFeed({
    teamId: TEAM,
    debounceMs: 100,
    reopenDelaysMs: [1_000, 5_000],
    probe: () => probe(),
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

const listen = () => feed.subscribe((moved) => heard.push(moved));

describe("workspace event feed (KOBE-599)", () => {
  it("opens one stream while listened to, for the page's team", () => {
    expect(sources).toHaveLength(0);
    const stop = listen();
    const stop2 = feed.subscribe(() => undefined);
    expect(sources.map((s) => s.url)).toEqual([workspaceEventsUrl(TEAM)]);
    expect(sources[0]?.url).toBe(`/v1/workspace/events?team=${TEAM}`);
    stop();
    expect(feed.streaming).toBe(true);
    stop2();
    expect(feed.streaming).toBe(false);
    expect(sources[0]?.readyState).toBe(2);
  });

  it("ignores the first state, then tells what moved, once per burst", async () => {
    listen();
    const s = src(0);
    s.send("workspace.state", v(1));
    await vi.advanceTimersByTimeAsync(500);
    expect(heard).toEqual([]);
    s.send("workspace.changed", v(2));
    s.send("workspace.changed", v(3));
    s.send("workspace.changed", v(3, "b"));
    await vi.advanceTimersByTimeAsync(99);
    expect(heard).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(heard).toEqual([{ files: true, projects: true }]);
    // Same versions again (a hint that changed nothing for us): nothing.
    s.send("workspace.changed", v(3, "b"));
    await vi.advanceTimersByTimeAsync(200);
    expect(heard).toHaveLength(1);
    s.send("workspace.changed", v(3, "c"));
    await vi.advanceTimersByTimeAsync(100);
    expect(heard.at(-1)).toEqual({ files: false, projects: true });
  });

  it("drops malformed messages", async () => {
    listen();
    const s = src(0);
    s.send("workspace.state", v(1));
    s.send("workspace.changed", { files_rev: -1, projects_rev: "x" });
    s.send("workspace.changed", { files_rev: 5 });
    await vi.advanceTimersByTimeAsync(200);
    expect(heard).toEqual([]);
  });

  it("catches up after the server ended the stream: a different state on reconnect is a change", async () => {
    listen();
    src(0).send("workspace.state", v(1));
    src(0).end();
    await vi.advanceTimersByTimeAsync(999);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(2);
    src(1).send("workspace.state", v(4));
    await vi.advanceTimersByTimeAsync(100);
    expect(heard).toEqual([{ files: true, projects: false }]);
  });

  it("stops for good when the page's team is no longer the active one", async () => {
    listen();
    probe = () => Promise.resolve(false);
    src(0).end();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sources).toHaveLength(1);
    expect(feed.stopped).toBe(true);
  });

  it("a panel that comes back starts from its own listing", async () => {
    const stop = listen();
    src(0).send("workspace.state", v(1));
    stop();
    listen();
    src(1).send("workspace.state", v(7));
    await vi.advanceTimersByTimeAsync(200);
    expect(heard).toEqual([]);
  });
});
