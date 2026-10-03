import { describe, expect, it } from "vitest";
import { newLiveRun, type LiveRun } from "./live";
import { clearResumePoint, loadResumePoint, saveResumePoint, type ResumeStore } from "./resume";

function memory(): ResumeStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

const RUN = "00000000-0000-4000-8000-000000000101";
const at = (patch: Partial<LiveRun>): LiveRun => ({
  ...newLiveRun(RUN),
  started: true,
  lastSeq: 7,
  committed: ["e1", "e2"],
  promptCommitted: true,
  ...patch,
});

describe("resume points", () => {
  it("saves only when nothing lives only in the stream, and loads when the entries cover it", () => {
    const store = memory();
    saveResumePoint(store, at({ committed: [] }));
    saveResumePoint(store, at({ messages: [{ messageId: "m", parts: [] }] }));
    expect(store.map.size).toBe(0);
    saveResumePoint(store, at({}));
    expect(loadResumePoint(store, RUN, new Set(["e1", "e2", "e3"]))?.lastSeq).toBe(7);
    expect(loadResumePoint(store, RUN, new Set(["e1"]))).toBeUndefined(); // entries don't cover it
    clearResumePoint(store, RUN);
    expect(loadResumePoint(store, RUN, new Set(["e1", "e2"]))).toBeUndefined();
  });

  it("drops tool inputs and long previews, and ignores garbage or another run's point", () => {
    const store = memory();
    saveResumePoint(
      store,
      at({
        tools: {
          tc1: {
            call: {
              tool_call_id: "tc1",
              tool: "bash",
              input: { secret: "x".repeat(10) },
              risk: "write",
            },
            result: {
              tool_call_id: "tc1",
              tool: "bash",
              is_error: false,
              preview: "y".repeat(5000),
              truncated: false,
            },
            egressBlocked: [],
            artifacts: [],
            files: [],
          },
        },
      }),
    );
    const loaded = loadResumePoint(store, RUN, new Set(["e1", "e2"]));
    expect(loaded?.tools.tc1?.call?.input).toEqual({});
    expect(loaded?.tools.tc1?.result?.preview).toHaveLength(2000);
    store.map.set([...store.map.keys()][0] ?? "", "{not json");
    expect(loadResumePoint(store, RUN, new Set(["e1", "e2"]))).toBeUndefined();
    store.map.set("kobe.chat.resume." + RUN, JSON.stringify({ ...at({}), runId: "other" }));
    expect(loadResumePoint(store, RUN, new Set(["e1", "e2"]))).toBeUndefined();
  });

  it("never throws when storage is blocked", () => {
    const blocked: ResumeStore = {
      get: () => {
        throw new Error("blocked");
      },
      set: () => {
        throw new Error("blocked");
      },
      remove: () => {
        throw new Error("blocked");
      },
    };
    expect(() => saveResumePoint(blocked, at({}))).not.toThrow();
    expect(loadResumePoint(blocked, RUN, new Set())).toBeUndefined();
    expect(() => clearResumePoint(blocked, RUN)).not.toThrow();
  });
});
