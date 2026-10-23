import { describe, expect, it } from "vitest";
import type { WorkspaceFileChange } from "@kobe/protocol";
import type { RunEventHub, WorkspaceHubSubscriber } from "../event-stream/hub.js";
import { SseReader } from "../testing/sse.js";
import { createWorkspaceChangeStream, type ChangeSource } from "./change-stream.js";

const SHA = (c: string) => c.repeat(64);
const USER = "0b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11";

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
  revalidate() {
    for (const s of this.subs.keys()) s.revalidate?.();
  }
}

/** A manifest: rows by revision; `reads` counts reads, `allowed` drives revalidation. */
class FakeManifest {
  rows: WorkspaceFileChange[] = [];
  reads: number[] = [];
  allowed = true;
  head = 0;
  put(path: string, sha: string | null, actor: WorkspaceFileChange["actor"] = null) {
    this.head += 1;
    const rev = this.head;
    this.rows = [
      ...this.rows.filter((r) => r.path !== path),
      { path, sha256: sha, rev, actor, at: "2026-10-23T10:00:00.000Z" },
    ];
  }
  source(paths: readonly string[]): ChangeSource {
    return {
      read: async (after) => {
        this.reads.push(after);
        return this.rows.filter((r) => paths.includes(r.path) && r.rev > after);
      },
      revalidate: async () => this.allowed,
    };
  }
}

const FAST = { keepaliveMs: 20, safetyReadMs: 10_000, stallTimeoutMs: 5_000, revalidateMs: 40 };

function open(hub: FakeHub, manifest: FakeManifest, paths: string[], debounceMs = 30) {
  let ended = 0;
  const body = createWorkspaceChangeStream({
    userId: USER,
    paths,
    source: manifest.source(paths),
    hub: hub as unknown as RunEventHub,
    timings: FAST,
    debounceMs,
    onEnd: () => (ended += 1),
  });
  return { reader: new SseReader(body), ended: () => ended };
}

async function nextData(reader: SseReader) {
  for (;;) {
    const frame = await reader.next();
    if (!frame) return undefined;
    if (frame.data !== undefined) {
      return { event: frame.event, change: JSON.parse(frame.data) as WorkspaceFileChange };
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("workspace change stream (KOBE-496)", () => {
  it("starts with one file.state per path, never-seen paths included", async () => {
    const hub = new FakeHub();
    const m = new FakeManifest();
    m.put("a.md", SHA("a"), { kind: "agent", name: null });
    m.put("other.md", SHA("o"));
    const { reader } = open(hub, m, ["a.md", "b.md"]);
    expect(await nextData(reader)).toEqual({
      event: "file.state",
      change: expect.objectContaining({ path: "a.md", sha256: SHA("a"), rev: 1 }),
    });
    expect(await nextData(reader)).toEqual({
      event: "file.state",
      change: { path: "b.md", sha256: null, rev: 0, actor: null, at: null },
    });
    expect([...hub.subs.values()]).toEqual([USER]);
    await reader.cancel();
    expect(hub.subs.size).toBe(0);
  });

  it("sends newer revisions of its paths as file.changed, one read per burst of hints", async () => {
    const hub = new FakeHub();
    const m = new FakeManifest();
    m.put("a.md", SHA("a"));
    const { reader } = open(hub, m, ["a.md"]);
    await nextData(reader);
    const readsBefore = m.reads.length;
    m.put("elsewhere.md", SHA("e"));
    m.put("a.md", SHA("b"), { kind: "user", name: "Ann" });
    hub.changed();
    hub.changed();
    hub.changed();
    expect(await nextData(reader)).toEqual({
      event: "file.changed",
      change: expect.objectContaining({ path: "a.md", sha256: SHA("b"), rev: 3 }),
    });
    expect(m.reads.slice(readsBefore)).toEqual([1]);
    // A deletion is a change with no version.
    m.put("a.md", null, { kind: "user", name: "Ann" });
    hub.changed();
    expect((await nextData(reader))?.change).toEqual(
      expect.objectContaining({ path: "a.md", sha256: null, rev: 4 }),
    );
    await reader.cancel();
  });

  it("ends once the viewer may no longer read (revalidation) and frees its slot", async () => {
    const hub = new FakeHub();
    const m = new FakeManifest();
    const s = open(hub, m, ["a.md"]);
    await nextData(s.reader);
    m.allowed = false;
    await sleep(120);
    expect(await nextData(s.reader)).toBeUndefined();
    expect(s.ended()).toBe(1);
    expect(hub.subs.size).toBe(0);
  });

  it("rechecks the viewer at once on an access hint, not at the next periodic check", async () => {
    const hub = new FakeHub();
    const m = new FakeManifest();
    let ended = 0;
    const body = createWorkspaceChangeStream({
      userId: USER,
      paths: ["a.md"],
      source: m.source(["a.md"]),
      hub: hub as unknown as RunEventHub,
      timings: { ...FAST, revalidateMs: 60_000 },
      onEnd: () => (ended += 1),
    });
    const reader = new SseReader(body);
    await nextData(reader);
    m.allowed = false;
    hub.revalidate();
    expect(await nextData(reader)).toBeUndefined();
    expect(ended).toBe(1);
  });

  it("never sends anything to a viewer refused at the first check", async () => {
    const hub = new FakeHub();
    const m = new FakeManifest();
    m.put("a.md", SHA("a"));
    m.allowed = false;
    const s = open(hub, m, ["a.md"]);
    expect(await nextData(s.reader)).toBeUndefined();
    expect(m.reads).toEqual([]);
  });

  it("ends when the hub shuts down", async () => {
    const hub = new FakeHub();
    const m = new FakeManifest();
    const s = open(hub, m, ["a.md"]);
    await nextData(s.reader);
    hub.close();
    expect(await nextData(s.reader)).toBeUndefined();
    expect(s.ended()).toBe(1);
  });
});
