import { beforeEach, describe, expect, it } from "vitest";
import {
  assistant,
  compaction,
  modelChange,
  resetEntrySeq,
  text,
  toolCall,
  toolResult,
  user,
} from "./testing/entries";
import { placeRunMarkers, type RunMarker } from "./markers";
import { messageMeta, projectThread, type Projection } from "./tree";
import { must } from "../testing/must";

beforeEach(() => resetEntrySeq());

/**
 * KOBE-209 (CE12, CE16): entries that are not conversation turns become inline markers in the
 * message they sit in (or before the first message below them), never messages of their own, so
 * grouping and branches stay as they were.
 */
function shape(p: Projection) {
  return p.items.map((i) => [i.message.id, i.parentId, i.message.role]);
}

function meta(p: Projection, id: string) {
  return messageMeta(must(p.items.find((i) => i.message.id === id)).message);
}

describe("projectThread markers", () => {
  it("marks a model change before the first message and a compaction after an answer", () => {
    const entries = [
      modelChange("m0", null, "fast"),
      user("u1", "m0", "hi"),
      assistant("a1", "u1", text("hello")),
      user("u2", "a1", "more"),
      assistant("a2", "u2", text("sure")),
      compaction("c1", "a2", "We said hello.", "u2"),
      user("u3", "c1", "again"),
    ];
    const p = projectThread(entries, "u3");
    expect(shape(p)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
      ["u2", "a1", "user"],
      ["a2", "u2", "assistant"],
      ["u3", "a2", "user"],
    ]);
    expect(meta(p, "u1")).toMatchObject({
      before: [{ kind: "model", entryId: "m0", model: "fast" }],
    });
    expect(meta(p, "a2")).toMatchObject({
      after: [
        {
          kind: "compaction",
          entryId: "c1",
          summary: "We said hello.",
          folded: 2,
          tokensBefore: 120_000,
        },
      ],
    });
    expect(meta(p, "a1")).not.toHaveProperty("after");
    expect(p.lastEntryOfNode.get("a2")).toBe("c1");
  });

  it("puts a marker inside the turn where it happened", () => {
    const entries = [
      user("u1", null, "go"),
      assistant("a1", "u1", toolCall("tc1", "bash")),
      toolResult("r1", "a1", "tc1", "ok"),
      compaction("c1", "r1", "Ran a script.", "a1"),
      assistant("a2", "c1", text("Done")),
    ];
    const p = projectThread(entries, "a2");
    expect(shape(p)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
    ]);
    const content = must(p.items[1]).message.content as readonly { type: string }[];
    expect(content.map((part) => part.type)).toEqual(["tool-call", "data-kobe-marker", "text"]);
    expect(content[1]).toMatchObject({ data: { kind: "compaction", folded: 1 } });
    expect(meta(p, "a1")).not.toHaveProperty("after");
  });

  it("keeps a marker on its own branch after a fork", () => {
    const entries = [
      user("u1", null, "q"),
      assistant("a1", "u1", text("a")),
      user("u2", "a1", "branch A"),
      modelChange("m1", "a1", "deep"),
      user("u3", "m1", "branch B"),
    ];
    const p = projectThread(entries, "u3");
    expect(shape(p)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
      ["u2", "a1", "user"],
      ["u3", "a1", "user"],
    ]);
    expect(meta(p, "u3")).toMatchObject({ before: [{ kind: "model", model: "deep" }] });
    expect(meta(p, "u2")).not.toHaveProperty("before");
    expect(meta(p, "a1")).not.toHaveProperty("after");
    expect(p.headId).toBe("u3");
  });

  it("counts only what a compaction newly folds", () => {
    const entries = [
      user("u1", null, "1"),
      assistant("a1", "u1", text("1")),
      user("u2", "a1", "2"),
      assistant("a2", "u2", text("2")),
      compaction("c1", "a2", "first", "u2"),
      user("u3", "c1", "3"),
      assistant("a3", "u3", text("3")),
      compaction("c2", "a3", "second", "a3"),
    ];
    const p = projectThread(entries, "c2");
    const folded = (id: string) =>
      (meta(p, id) as { after?: readonly { folded?: number }[] }).after?.[0]?.folded;
    expect(folded("a2")).toBe(2); // u1, a1
    expect(folded("a3")).toBe(3); // u2, a2 (kept by c1), u3
  });

  it("shows an offloaded compaction as a marker, not as part of an answer", () => {
    const big = { ...compaction("c1", "a1", "", "u1"), payload: {}, payloadOffloaded: true };
    const entries = [user("u1", null, "q"), assistant("a1", "u1", text("a")), big];
    const p = projectThread(entries, "c1");
    expect(must(p.items[1]).message.content).toEqual([{ type: "text", text: "a" }]);
    expect(meta(p, "a1")).toMatchObject({
      after: [{ kind: "compaction", entryId: "c1", summary: "" }],
    });
  });
});

describe("placeRunMarkers", () => {
  const run = (over: Partial<RunMarker>): RunMarker => ({
    runId: "r1",
    status: "interrupted",
    userEntryId: null,
    parentEntryId: null,
    endedAt: null,
    ...over,
  });

  it("puts a run's marker after its answer, under its prompt, or after where it started", () => {
    const entries = [
      user("u1", null, "q"),
      assistant("a1", "u1", text("a")),
      assistant("a1b", "a1", text("more")),
      user("u2", "a1b", "never answered"),
    ];
    const p = projectThread(entries, "u2");
    const placed = placeRunMarkers(
      [
        run({ runId: "r1", userEntryId: "u1", status: "budget_stopped" }),
        run({ runId: "r2", userEntryId: "u2" }),
        run({ runId: "r3", parentEntryId: "a1b" }),
        run({ runId: "r4", userEntryId: "gone" }),
      ],
      p,
    );
    expect([...placed.entries()].map(([id, runs]) => [id, runs.map((r) => r.runId)])).toEqual([
      ["a1", ["r1", "r3"]],
      ["u2", ["r2"]],
    ]);
  });
});
