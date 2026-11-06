/** KOBE-546 (CT4, CT8, CT9, CT18): the tree panel's pure half. */
import { beforeEach, describe, expect, it } from "vitest";
import { assistant, branchMarker, entry, resetEntrySeq, text, toolCall, user } from "./testing/entries";
import { must } from "../testing/must";
import { projectTree, type TreeNode } from "./tree-nodes";
import { projectThread } from "./tree";
import {
  GHOST_TEXT,
  LABEL_BAD_CHARS,
  LABEL_EMPTY,
  LABEL_TOO_LONG,
  badgeTexts,
  checkLabel,
  filesLeftBehind,
  nodeEntries,
  headerCounts,
  isContinuable,
  junctionGroups,
  labelErrorMessage,
  matchesFilter,
  moveFocus,
  nodeName,
  siblingsOf,
  treeMenu,
  type TreeMenuContext,
} from "./tree-panel";
import type { ThreadEntry } from "./types";

beforeEach(() => resetEntrySeq());

const twoVersions = (): ThreadEntry[] => [
  entry("r0", null, null, "thinking_level_change"),
  user("u1", "r0", "start"),
  assistant("a1", "u1", text("ok")),
  user("v1", "a1", "first version"),
  assistant("b1", "v1", toolCall("c1", "write", { path: "plan.md" })),
  branchMarker("k2", "a1"),
  user("v2", "k2", "second version"),
  assistant("b2", "v2", text("answer two")),
];

const tree = (head = "b2") =>
  projectTree(twoVersions(), head, "b2", {
    labels: [{ entry_id: "v1", label: "try 5% cut" }],
    runs: [],
  });
const nodeOf = (id: string, t = tree()) => must(t.nodes.find((n) => n.id === id), id);

const ctx: TreeMenuContext = {
  owner: true,
  testThread: false,
  inTrash: false,
  offLeafBranch: false,
  hasSiblings: false,
  canEdit: true,
  canRetry: false,
  forkable: true,
};

describe("texts", () => {
  it("counts branches and forks with singulars", () => {
    expect(headerCounts(1, 0)).toBe("1 branch · 0 forks");
    expect(headerCounts(3, 2)).toBe("3 branches · 2 forks");
  });

  it("shows and speaks the badges", () => {
    expect(badgeTexts({ files: 2, paths: ["a", "b"], memories: 1, rule: true })).toEqual([
      { kind: "files", shown: "📄 2 files", spoken: "2 files changed" },
      { kind: "memories", shown: "🧠 1 memory", spoken: "1 memory written" },
      { kind: "rule", shown: "🔏 rule", spoken: "approval rule remembered" },
    ]);
    expect(badgeTexts({})).toEqual([]);
  });

  it("names a row: role, excerpt, time, label, badges", () => {
    expect(nodeName(nodeOf("v1"), "12:14")).toBe("You, first version, 12:14, try 5% cut");
    expect(nodeName(nodeOf("b1"), "12:15")).toBe("Agent, (tools only), 12:15, 1 file changed");
    const ghost = { ...nodeOf("b2"), empty: true as const, excerpt: "" };
    expect(nodeName(ghost, "1")).toBe(`Agent, ${GHOST_TEXT}, 1`);
  });

  it("filters on text and label, every word", () => {
    expect(matchesFilter(nodeOf("v1"), "5% cut")).toBe(true);
    expect(matchesFilter(nodeOf("v1"), "FIRST")).toBe(true);
    expect(matchesFilter(nodeOf("v2"), "cut")).toBe(false);
    expect(matchesFilter(nodeOf("v2"), "  ")).toBe(true);
  });
});

describe("the node menu (CT4)", () => {
  it("offers the owner's items in the spec's order", () => {
    const t = tree();
    expect(treeMenu(nodeOf("v1", t), t, { ...ctx, offLeafBranch: true, hasSiblings: true })).toEqual(
      ["show", "make-current", "edit", "label", "remove-label", "fork", "copy"],
    );
    expect(treeMenu(nodeOf("a1", t), t, ctx)).toEqual(["show", "continue", "label", "fork", "copy"]);
  });

  it("never offers Continue from here on the leaf's last answer", () => {
    const t = tree();
    expect(isContinuable(nodeOf("b2", t), t)).toBe(false);
    expect(isContinuable(nodeOf("b1", t), t)).toBe(true);
    expect(isContinuable(nodeOf("v1", t), t)).toBe(false);
    expect(treeMenu(nodeOf("b2", t), t, ctx)).not.toContain("continue");
  });

  it("gives a reader only what changes nothing", () => {
    const t = tree();
    expect(treeMenu(nodeOf("b1", t), t, { ...ctx, owner: false, offLeafBranch: true })).toEqual([
      "show",
      "fork",
    ]);
  });

  it("hides labels and fork on test threads, keeps Continue from here (CT19)", () => {
    const t = tree();
    expect(treeMenu(nodeOf("a1", t), t, { ...ctx, testThread: true })).toEqual([
      "show",
      "continue",
      "copy",
    ]);
  });

  it("shows Compare and carry-a-summary only once they ship", () => {
    const t = tree();
    const off = { ...ctx, offLeafBranch: true, hasSiblings: true };
    expect(treeMenu(nodeOf("v1", t), t, off)).not.toContain("compare");
    const later = treeMenu(nodeOf("v1", t), t, { ...off, compare: true, carrySummary: true });
    expect(later).toContain("compare");
    expect(later).toContain("carry-summary");
  });

  it("offers Retry on a ghost that can retry", () => {
    const t = tree();
    const ghost: TreeNode = { ...nodeOf("b2", t), id: "empty:k9", empty: true, excerpt: "" };
    expect(treeMenu(ghost, t, { ...ctx, canRetry: true })).toContain("retry");
    expect(treeMenu(ghost, t, ctx)).not.toContain("retry");
  });
});

describe("keyboard moves (CT4)", () => {
  it("moves by row, by sibling, Home to the root and End to the leaf", () => {
    const t = tree();
    const rows = t.nodes.map((n) => n.id);
    const sib = siblingsOf(t.nodes);
    expect(moveFocus(rows, "a1", "ArrowDown", sib, t.leafId)).toBe("v1");
    expect(moveFocus(rows, "u1", "ArrowUp", sib, t.leafId)).toBe("u1");
    expect(moveFocus(rows, "v1", "ArrowRight", sib, t.leafId)).toBe("v2");
    expect(moveFocus(rows, "v2", "ArrowRight", sib, t.leafId)).toBe("v2");
    expect(moveFocus(rows, "v2", "ArrowLeft", sib, t.leafId)).toBe("v1");
    expect(moveFocus(rows, "b2", "Home", sib, t.leafId)).toBe("u1");
    expect(moveFocus(rows, "u1", "End", sib, t.leafId)).toBe("b2");
    expect(moveFocus([], undefined, "End", sib, null)).toBeUndefined();
  });
});

describe("the narrow list (CT18)", () => {
  it("groups branches by junction, headed by the node above, with chips below them", () => {
    const groups = junctionGroups(tree());
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group?.parent?.id).toBe("a1");
    expect(group?.branches.map((b) => [b.node.id, b.onScreen, b.isLeaf, b.badges])).toEqual([
      ["v1", false, false, { files: 1 }],
      ["v2", true, true, {}],
    ]);
  });

  it("has no groups for a straight thread", () => {
    expect(junctionGroups(projectTree(twoVersions().slice(0, 5), "b1"))).toEqual([]);
  });
});

describe("labels (CT9)", () => {
  it("trims and checks 1-60 characters on one line", () => {
    expect(checkLabel("  the good one ")).toEqual({ ok: true, label: "the good one" });
    expect(checkLabel("   ")).toEqual({ ok: false, message: LABEL_EMPTY });
    expect(checkLabel("x".repeat(61))).toEqual({ ok: false, message: LABEL_TOO_LONG });
    expect(checkLabel("x".repeat(60)).ok).toBe(true);
    expect(checkLabel("two\nlines")).toEqual({ ok: false, message: LABEL_BAD_CHARS });
  });

  it("says the server's refusals in fixed words", () => {
    expect(labelErrorMessage("test_thread")).toBe("Test conversations can't be labelled.");
    expect(labelErrorMessage("whatever")).toBe("The label could not be saved. Try again.");
  });
});

describe("node entries and files left behind (CT6)", () => {
  it("finds a node's first and last entries, a ghost's marker", () => {
    const p = projectThread(twoVersions(), "b2", "b2");
    expect(nodeEntries(p, "v2")).toMatchObject({ first: "v2", last: "v2" });
    expect(nodeEntries(p, "b1")).toMatchObject({ first: "b1", last: "b1" });
    expect(nodeEntries(p, "empty:k9")).toEqual({ first: "k9", last: "k9" });
  });

  it("says so only when the leaf's branch being left changed files", () => {
    const fromV1 = projectTree(twoVersions(), "b2", "b1");
    expect(filesLeftBehind(fromV1, "b2")).toBe(true);
    expect(filesLeftBehind(fromV1, "b1")).toBe(false);
    expect(filesLeftBehind(tree(), "b1")).toBe(false);
  });
});
