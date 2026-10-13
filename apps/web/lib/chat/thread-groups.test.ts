import { describe, expect, it } from "vitest";
import { GROUP_ORDER, groupThreads, placementOf } from "./thread-groups";

const listed = (id: string, custom: unknown) => ({ id, custom });

describe("thread groups (CE5)", () => {
  it("keeps the fixed order and list order inside a group; projects by name", () => {
    const groups = groupThreads(
      [
        listed("a", { projectId: null, scheduled: false, shared: false }),
        listed("b", { projectId: "p2", scheduled: false, shared: false }),
        listed("c", { projectId: "p1", scheduled: true, shared: false }),
        listed("d", { projectId: "p1", scheduled: false, shared: true }),
        listed("e", { projectId: "p1", scheduled: false, shared: false }),
        listed("f", undefined), // not listed yet (a thread just created)
        listed("g", { projectId: "p3", scheduled: false, shared: false }),
      ],
      ["t1", "t2"],
      (id) => ({ p1: "Zebra", p2: "Alpha" })[id],
    );
    expect(groups.map((g) => [g.label, g.threads.map((t) => `${t.id}@${t.index}`)])).toEqual([
      ["Alpha", ["b@1"]],
      ["Project", ["g@6"]], // a project the names read did not return
      ["Zebra", ["e@4"]],
      ["Your threads", ["a@0", "f@5"]],
      ["Scheduled", ["c@2"]],
      ["Shared with me", ["d@3"]],
      ["Trash", ["t1@0", "t2@1"]],
    ]);
    expect(GROUP_ORDER).toEqual([
      "pinned",
      "project",
      "ungrouped",
      "scheduled",
      "shared",
      "archived",
      "trash",
    ]);
  });

  it("shows no group without threads: an empty Trash is hidden", () => {
    expect(groupThreads([], [], () => undefined)).toEqual([]);
  });

  it("reads malformed placements as ungrouped", () => {
    for (const custom of [null, "x", 3, { projectId: 7, scheduled: "yes", shared: 1 }]) {
      expect(placementOf(custom)).toEqual({ projectId: null, scheduled: false, shared: false });
    }
  });
});
