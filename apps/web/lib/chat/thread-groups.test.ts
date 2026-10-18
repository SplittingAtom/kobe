import { describe, expect, it } from "vitest";
import {
  adjacentThread,
  GROUP_ORDER,
  groupThreads,
  placementOf,
  threadOrder,
} from "./thread-groups";

const listed = (id: string, custom: unknown) => ({ id, custom });

describe("thread groups (CE5)", () => {
  it("keeps the fixed order and list order inside a group; projects by name", () => {
    const groups = groupThreads(
      [
        listed("a", { projectId: null, scheduled: false, shared: false }),
        listed("b", { projectId: "p2", scheduled: false, shared: false }),
        listed("c", { projectId: null, scheduled: true, shared: false }),
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
      "workbench",
      "shared",
      "archived",
      "trash",
    ]);
  });

  it("keeps Workbench test chats in their own group, after Scheduled (KOBE-323)", () => {
    const groups = groupThreads(
      [
        listed("a", { projectId: null }),
        listed("w1", { projectId: null, workbench: true }),
        listed("s", { projectId: null, scheduled: true }),
        listed("w2", { projectId: null, workbench: true, pinned: true }),
      ],
      [],
      () => undefined,
    );
    expect(groups.map((g) => [g.kind, g.label, g.threads.map((t) => t.id)])).toEqual([
      ["pinned", "Pinned", ["w2"]],
      ["ungrouped", "Your threads", ["a"]],
      ["scheduled", "Scheduled", ["s"]],
      ["workbench", "Workbench", ["w1"]],
    ]);
  });

  it("puts pinned threads first and archived ones in Archived, whatever their project (CE19)", () => {
    const groups = groupThreads(
      [
        listed("p2", { projectId: null, pinned: true }),
        listed("p1", { projectId: "p1", pinned: true }),
        listed("a", { projectId: null }),
        listed("s", { projectId: null, scheduled: true }),
        // A scheduled thread moved into a project goes under the project.
        listed("m", { projectId: "p1", scheduled: true }),
        listed("x", { projectId: "p1", archived: true }),
        listed("y", { projectId: null, scheduled: true, archived: true }),
      ],
      ["t1"],
      (id) => ({ p1: "Budget" })[id],
    );
    expect(groups.map((g) => [g.kind, g.label, g.threads.map((t) => t.id)])).toEqual([
      ["pinned", "Pinned", ["p2", "p1"]],
      ["project", "Budget", ["m"]],
      ["ungrouped", "Your threads", ["a"]],
      ["scheduled", "Scheduled", ["s"]],
      ["archived", "Archived", ["x", "y"]],
      ["trash", "Trash", ["t1"]],
    ]);
    expect(groups.find((g) => g.kind === "project")?.projectId).toBe("p1");
  });

  it("shows no group without threads: an empty Trash is hidden", () => {
    expect(groupThreads([], [], () => undefined)).toEqual([]);
  });

  it("reads malformed placements as ungrouped", () => {
    for (const custom of [
      null,
      "x",
      3,
      { projectId: 7, scheduled: "yes", shared: 1, pinned: "true", archived: 1, workbench: 1 },
    ]) {
      expect(placementOf(custom)).toEqual({
        projectId: null,
        scheduled: false,
        workbench: false,
        shared: false,
        visibility: "private",
        pinned: false,
        archived: false,
      });
    }
  });

  it("lists a project-shared thread under Shared with me and in its project group (CE20)", () => {
    const groups = groupThreads(
      [
        listed("own", { projectId: "p1" }),
        listed("ps", { projectId: "p1", shared: true, visibility: "project" }),
        listed("ts", { projectId: "p1", shared: true, visibility: "team" }),
        listed("tl", { projectId: null, shared: true, visibility: "team" }),
      ],
      [],
      (id) => ({ p1: "Budget" })[id],
    );
    expect(groups.map((g) => [g.kind, g.threads.map((t) => `${t.id}@${t.index}`)])).toEqual([
      ["project", ["own@0", "ps@1"]],
      ["shared", ["ps@1", "ts@2", "tl@3"]],
    ]);
  });
});

/** KOBE-225 (CE23): Mod+[ and Mod+] step through the rail's conversations. */
describe("threadOrder and adjacentThread", () => {
  const listed = [
    { id: "a", custom: {} },
    { id: "p", custom: { pinned: true } },
    { id: "z", custom: { archived: true } },
    { id: "s", custom: { shared: true, visibility: "project", projectId: "x" } },
  ];

  it("follows the rail's groups, each thread once, without Archived or Trash", () => {
    const groups = groupThreads(listed, ["t"], () => undefined);
    expect(threadOrder(groups)).toEqual(["p", "s", "a"]);
  });

  it("orders project groups by name, as the rail, whatever the threads' recency", () => {
    const projects = [
      { id: "z1", custom: { projectId: "Z" } },
      { id: "a1", custom: { projectId: "A" } },
      { id: "z2", custom: { projectId: "Z" } },
      { id: "u", custom: {} },
    ];
    const names = new Map([
      ["Z", "Zeta"],
      ["A", "Alpha"],
    ]);
    expect(threadOrder(groupThreads(projects, [], (id) => names.get(id)))).toEqual([
      "a1",
      "z1",
      "z2",
      "u",
    ]);
  });

  it("steps without wrapping; from a draft both go to the first", () => {
    const order = ["p", "s", "a"];
    expect(adjacentThread(order, "s", -1)).toBe("p");
    expect(adjacentThread(order, "s", 1)).toBe("a");
    expect(adjacentThread(order, "p", -1)).toBeNull();
    expect(adjacentThread(order, "a", 1)).toBeNull();
    expect(adjacentThread(order, "draft", 1)).toBe("p");
    expect(adjacentThread(order, "draft", -1)).toBe("p");
    expect(adjacentThread([], "draft", 1)).toBeNull();
  });
});
