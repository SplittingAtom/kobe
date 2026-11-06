/** KOBE-545 (CT4 "Lanes", "Forks", "Performance"; ac-2): the git-graph layout. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newLiveRun } from "./live";
import { assistant, branchMarker, entry, resetEntrySeq, text, user } from "./testing/entries";
import { createTreeLayout, layoutTree, TREE_MAX_LANES, type TreeLayout } from "./tree-layout";
import { treeForks } from "./tree-forks";
import { projectTree } from "./tree-nodes";
import { must } from "../testing/must";
import type { ThreadEntry } from "./types";

beforeEach(() => resetEntrySeq());

const row = (layout: TreeLayout, id: string) => must(layout.byId.get(id), id);
const lanes = (layout: TreeLayout) => layout.rows.map((r) => [r.id, r.lane]);

/** A prompt with three versions under the first answer, made one after the other. */
const threeVersions = (): ThreadEntry[] => [
  entry("r0", null, null, "thinking_level_change"),
  user("u1", "r0", "start"),
  assistant("a1", "u1", text("ok")),
  user("v1", "a1", "first version"),
  assistant("b1", "v1", text("answer one")),
  branchMarker("k2", "a1"),
  user("v2", "k2", "second version"),
  assistant("b2", "v2", text("answer two")),
  branchMarker("k3", "a1"),
  user("v3", "k3", "third version"),
  assistant("b3", "v3", text("answer three")),
];

const layoutOf = (entries: ThreadEntry[], head: string) => {
  const tree = projectTree(entries, head, head, null);
  return layoutTree(tree.nodes);
};

describe("layoutTree (ac-2)", () => {
  it("draws a straight thread in lane 1, one row per node, connected to its parent", () => {
    const entries = threeVersions().slice(0, 5);
    const layout = layoutOf(entries, "b1");
    expect(lanes(layout)).toEqual([
      ["u1", 1],
      ["a1", 1],
      ["v1", 1],
      ["b1", 1],
    ]);
    expect(row(layout, "u1")).toMatchObject({ row: 0, parentRow: null, parentLane: null });
    expect(row(layout, "a1")).toMatchObject({ row: 1, parentRow: 0, parentLane: 1 });
    expect(layout.lanes).toBe(1);
  });

  it("puts the head's path in lane 1 whichever version it is", () => {
    for (const head of ["b1", "b2", "b3"]) {
      const layout = layoutOf(threeVersions(), head);
      const onPath = ["u1", "a1", `v${head.slice(1)}`, head];
      for (const id of onPath) expect(row(layout, id).lane, `${head}: ${id}`).toBe(1);
      const off = layout.rows.filter((r) => !onPath.includes(r.id));
      for (const r of off) expect(r.lane, `${head}: ${r.id}`).toBeGreaterThan(1);
    }
  });

  it("gives each other branch the next free lane at its branch point, newest sibling first", () => {
    const layout = layoutOf(threeVersions(), "b1");
    expect(row(layout, "v3").lane).toBe(2);
    expect(row(layout, "v2").lane).toBe(3);
    expect(row(layout, "v2")).toMatchObject({ parentRow: row(layout, "a1").row, parentLane: 1 });
  });

  it("orders rows by first entry seq: a later branch sits below an earlier one", () => {
    const layout = layoutOf(threeVersions(), "b3");
    expect(layout.rows.map((r) => r.id)).toEqual(["u1", "a1", "v1", "b1", "v2", "b2", "v3", "b3"]);
    expect(row(layout, "v2").row).toBeGreaterThan(row(layout, "b1").row);
    expect(row(layout, "v3").row).toBeGreaterThan(row(layout, "b2").row);
  });

  it("frees a lane after its last node, so a later branch reuses it", () => {
    // u1 → a1 → u2 → a2 (head). Branch x under a1 ends before branch y under a2 starts.
    const entries = [
      user("u1", null, "q"),
      assistant("a1", "u1", text("one")),
      user("u2", "a1", "q2"),
      branchMarker("kx", "a1"),
      user("x1", "kx", "other"),
      assistant("x2", "x1", text("other answer")),
      assistant("a2", "u2", text("two")),
      user("u3", "a2", "q3"),
      branchMarker("ky", "a2"),
      user("y1", "ky", "later"),
    ];
    const layout = layoutOf(entries, "u3");
    expect(row(layout, "x1").lane).toBe(2);
    expect(row(layout, "y1").lane).toBe(2);
    expect(layout.lanes).toBe(2);
  });

  it("draws root branches (two first messages) beside lane 1", () => {
    const entries = [
      entry("r0", null, null, "thinking_level_change"),
      user("u1", "r0", "first"),
      assistant("a1", "u1", text("one")),
      branchMarker("k1", "r0"),
      user("w1", "k1", "a better start"),
    ];
    const layout = layoutOf(entries, "w1");
    expect(row(layout, "w1").lane).toBe(1);
    expect(row(layout, "u1").lane).toBe(2);
    expect(row(layout, "u1").parentRow).toBeNull();
  });

  it("draws a ghost node in its own lane like any version", () => {
    const entries = [
      user("u1", null, "q"),
      assistant("a1", "u1", text("one")),
      branchMarker("k2", "u1"),
    ];
    const layout = layoutOf(entries, "a1");
    expect(row(layout, "empty:k2")).toMatchObject({ lane: 2, parentLane: 1, parentRow: 0 });
  });

  it(`overflows past ${TREE_MAX_LANES} lanes into lane ${TREE_MAX_LANES}, dotted`, () => {
    // Ten versions of one prompt, all alive at once: the head's path plus nine branches.
    const entries: ThreadEntry[] = [user("u1", null, "q"), assistant("a1", "u1", text("ok"))];
    for (let i = 0; i < 10; i++) {
      entries.push(branchMarker(`k${i}`, "a1"), user(`v${i}`, `k${i}`, `version ${i}`));
    }
    for (let i = 0; i < 10; i++) entries.push(assistant(`b${i}`, `v${i}`, text(`answer ${i}`)));
    const layout = layoutOf(entries, "b0");
    expect(row(layout, "v0").lane).toBe(1);
    const branchLanes = Array.from({ length: 9 }, (_, i) => row(layout, `v${i + 1}`));
    expect(Math.max(...branchLanes.map((r) => r.lane))).toBe(TREE_MAX_LANES);
    const dotted = branchLanes.filter((r) => r.dotted);
    expect(dotted.map((r) => r.lane)).toEqual([TREE_MAX_LANES, TREE_MAX_LANES]);
    expect(
      branchLanes
        .filter((r) => !r.dotted)
        .map((r) => r.lane)
        .sort(),
    ).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(layout.lanes).toBe(TREE_MAX_LANES);
    // The newest versions take the first free lanes; the oldest overflow.
    expect(row(layout, "v9").lane).toBe(2);
    expect(row(layout, "v1").dotted).toBe(true);
  });
});

describe("forks (CT4 Forks)", () => {
  it("maps a fork through nodeOfEntry to a dashed leaf row off its node, also off-screen", () => {
    const tree = projectTree(threeVersions(), "b3", "b3", null);
    const forks = treeForks(
      [
        { thread_id: "t-fork", title: "Budget — marketing cut", forked_at_entry_id: "b1" },
        { thread_id: "t-old", title: null, forked_at_entry_id: "k2" },
        { thread_id: "t-unknown", title: "x" },
      ],
      tree.nodeOfEntry,
    );
    expect(forks.placed).toEqual([
      { id: "fork:t-fork", threadId: "t-fork", title: "Budget — marketing cut", nodeId: "b1" },
      { id: "fork:t-old", threadId: "t-old", title: null, nodeId: "a1" },
    ]);
    expect(forks.unplaced).toBe(1);
    const layout = layoutTree(tree.nodes, forks.placed);
    const fork = row(layout, "fork:t-fork");
    expect(fork).toMatchObject({ kind: "fork", parentRow: row(layout, "b1").row });
    expect(fork.row).toBe(row(layout, "b1").row + 1);
    expect(fork.lane).not.toBe(row(layout, "b1").lane);
  });
});

describe("createTreeLayout: memoised (CT4 Performance, ac-2)", () => {
  it("lays out once per committed entries and head; the live node is appended", () => {
    const spy = vi.fn(layoutTree);
    const layout = createTreeLayout(spy);
    const entries = threeVersions();
    const first = layout(entries, "b3", projectTree(entries, "b3", "b3", null));
    expect(spy).toHaveBeenCalledTimes(1);

    const live = (text: string) => ({
      run: {
        ...newLiveRun("r1"),
        started: true,
        messages: [{ messageId: "m", parts: [{ kind: "text" as const, contentIndex: 0, text }] }],
      },
      active: true,
      prompt: { text: "next", parentEntryId: "b3" },
    });
    const a = layout(entries, "b3", projectTree(entries, "b3", "b3", null, live("par")));
    const b = layout(entries, "b3", projectTree(entries, "b3", "b3", null, live("partial")));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a.rows.slice(0, first.rows.length)).toEqual(first.rows);
    for (const [i, r] of first.rows.entries()) expect(b.rows[i]).toBe(r);
    expect(row(b, "prompt:r1")).toMatchObject({ lane: 1, parentRow: row(first, "b3").row });
    expect(row(b, "live:r1")).toMatchObject({ lane: 1, row: first.rows.length + 1 });

    expect(layout(entries, "b3", projectTree(entries, "b3", "b3", null))).toBe(first);
    layout(entries, "b1", projectTree(entries, "b1", "b1", null));
    expect(spy).toHaveBeenCalledTimes(2);
    const more = [...entries, user("v4", "b3", "again")];
    layout(more, "v4", projectTree(more, "v4", "v4", null));
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("createTreeLayout: relaid when the committed nodes change (review)", () => {
  const live = (parentEntryId: string | null) => ({
    run: newLiveRun("r1"),
    active: true,
    prompt: { text: "again", parentEntryId },
  });

  it("drops a ghost under the head once the run's prompt shows", () => {
    const entries = [
      user("u1", null, "q"),
      assistant("a1", "u1", text("one")),
      branchMarker("k2", "a1"),
    ];
    const layout = createTreeLayout();
    expect(layout(entries, "k2", projectTree(entries, "k2", "k2", null)).byId.has("empty:k2")).toBe(
      true,
    );
    const sending = layout(entries, "k2", projectTree(entries, "k2", "k2", null, live("a1")));
    expect(sending.byId.has("empty:k2")).toBe(false);
    expect(sending.byId.has("prompt:r1")).toBe(true);
  });

  it("follows a leaf move (thread.updated) with the same entries array", () => {
    const entries = [
      user("u1", null, "q"),
      entry("a0", "u1", { role: "assistant", content: [], stopReason: "aborted" }),
      assistant("a1", "u1", text("one")),
    ];
    const layout = createTreeLayout();
    expect(layout(entries, "a1", projectTree(entries, "a1", "a1", null)).byId.has("a0")).toBe(
      false,
    );
    expect(layout(entries, "a1", projectTree(entries, "a1", "a0", null)).byId.has("a0")).toBe(true);
  });

  it("puts a new thread's first pending prompt in lane 1", () => {
    const layout = createTreeLayout();
    const tree = projectTree([], null, null, null, live(null));
    const result = layout([], null, tree);
    expect(row(result, "prompt:r1")).toMatchObject({ lane: 1, row: 0, dotted: false });
    expect(result.lanes).toBe(1);
  });
});
