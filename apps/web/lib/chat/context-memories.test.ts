import { describe, expect, it, vi } from "vitest";
import type { ThreadContextMemoryItem } from "@kobe/protocol";
import { memoryLanes, readThreadContextMemories } from "./context-memories";

const item = (
  n: number,
  lane: ThreadContextMemoryItem["lane"],
  pinned = false,
): ThreadContextMemoryItem => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  version: 1,
  lane,
  kind: "fact",
  statement: `statement ${n}`,
  pinned,
});

describe("memoryLanes", () => {
  it("groups by lane in render order with the context viewer's labels", () => {
    const lanes = memoryLanes([
      item(1, "user"),
      item(2, "policy"),
      item(3, "team"),
      item(4, "user"),
    ]);
    expect(lanes.map((l) => [l.lane, l.label, l.items.length])).toEqual([
      ["policy", "Policy", 1],
      ["team", "Workspace memories", 1],
      ["user", "My memories in this workspace", 2],
    ]);
  });
});

describe("readThreadContextMemories", () => {
  it("reads the route with the team header and validates it", async () => {
    const body = { thread_id: item(9, "team").id, run_id: null, latest: true, items: [] };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    expect(await readThreadContextMemories("t 1", "team-1", fetchFn as typeof fetch)).toEqual(body);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/threads/t%201/context/memories");
    expect((init.headers as Record<string, string>)["x-kobe-team"]).toBe("team-1");
  });

  it("answers null for a reader's 403 and for a malformed body", async () => {
    const forbidden = vi.fn(async () => new Response("{}", { status: 403 }));
    expect(await readThreadContextMemories("t", "x", forbidden as typeof fetch)).toBeNull();
    const bad = vi.fn(async () => new Response('{"items":1}', { status: 200 }));
    expect(await readThreadContextMemories("t", "x", bad as typeof fetch)).toBeNull();
  });
});
