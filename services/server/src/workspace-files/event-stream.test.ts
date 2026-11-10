import { describe, expect, it } from "vitest";
import type { WorkspaceEvent } from "@kobe/protocol";
import type { RunEventHub, WorkspaceHubSubscriber } from "../event-stream/hub.js";
import { SseReader } from "../testing/sse.js";
import { createWorkspaceEventStream } from "./event-stream.js";

const USER = "0b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11";
const FAST = { keepaliveMs: 20, safetyReadMs: 10_000, stallTimeoutMs: 5_000, revalidateMs: 40 };

class FakeHub implements Pick<RunEventHub, "subscribeWorkspace"> {
  subs = new Map<WorkspaceHubSubscriber, string>();
  subscribeWorkspace(userId: string, s: WorkspaceHubSubscriber) {
    this.subs.set(s, userId);
    return () => this.subs.delete(s);
  }
  changed() {
    for (const s of this.subs.keys()) s.changed();
  }
  close() {
    for (const s of this.subs.keys()) s.close();
  }
}

function open(hub: FakeHub, state: { v: WorkspaceEvent; reads: number; allowed: boolean }) {
  let ended = 0;
  const body = createWorkspaceEventStream({
    userId: USER,
    hub: hub as unknown as RunEventHub,
    timings: FAST,
    debounceMs: 30,
    read: async () => {
      state.reads += 1;
      return state.v;
    },
    revalidate: async () => state.allowed,
    onEnd: () => (ended += 1),
  });
  return { reader: new SseReader(body), ended: () => ended };
}

async function nextData(reader: SseReader) {
  for (;;) {
    const frame = await reader.next();
    if (!frame) return undefined;
    if (frame.data !== undefined) {
      return { event: frame.event, data: JSON.parse(frame.data) as WorkspaceEvent };
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("workspace event stream (KOBE-599)", () => {
  it("sends the state first, then changed only when a version moved", async () => {
    const hub = new FakeHub();
    const state = { v: { files_rev: 3, projects_rev: "a" }, reads: 0, allowed: true };
    const { reader } = open(hub, state);
    expect(await nextData(reader)).toEqual({
      event: "workspace.state",
      data: { files_rev: 3, projects_rev: "a" },
    });
    expect([...hub.subs.values()]).toEqual([USER]);
    // A hint that changed nothing for this workspace (another team's, a forged one): no event.
    hub.changed();
    await sleep(80);
    state.v = { files_rev: 4, projects_rev: "a" };
    hub.changed();
    expect(await nextData(reader)).toEqual({
      event: "workspace.changed",
      data: { files_rev: 4, projects_rev: "a" },
    });
    state.v = { files_rev: 4, projects_rev: "b" };
    hub.changed();
    expect(await nextData(reader)).toEqual({
      event: "workspace.changed",
      data: { files_rev: 4, projects_rev: "b" },
    });
    await reader.cancel();
  });

  it("coalesces a burst of hints into one read", async () => {
    const hub = new FakeHub();
    const state = { v: { files_rev: 1, projects_rev: "a" }, reads: 0, allowed: true };
    const { reader } = open(hub, state);
    await nextData(reader);
    const before = state.reads;
    state.v = { files_rev: 9, projects_rev: "a" };
    for (let i = 0; i < 10; i++) hub.changed();
    expect((await nextData(reader))?.data.files_rev).toBe(9);
    expect(state.reads - before).toBe(1);
    await reader.cancel();
  });

  it("ends when the viewer may no longer read the workspace, and on hub close", async () => {
    const hub = new FakeHub();
    const state = { v: { files_rev: 1, projects_rev: "a" }, reads: 0, allowed: true };
    const first = open(hub, state);
    await nextData(first.reader);
    state.allowed = false;
    expect(await nextData(first.reader)).toBeUndefined();
    expect(first.ended()).toBe(1);

    state.allowed = true;
    const second = open(hub, state);
    await nextData(second.reader);
    hub.close();
    expect(await nextData(second.reader)).toBeUndefined();
    expect(second.ended()).toBe(1);
  });
});
