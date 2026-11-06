/** KOBE-545 (CT1, CT5, CT6, CT12): the tree's nodes are the conversation's messages. */
import { beforeEach, describe, expect, it } from "vitest";
import { newLiveRun } from "./live";
import {
  answered,
  appCardEntry,
  assistant,
  branchMarker,
  branchSummary,
  compaction,
  entry,
  modelChange,
  namedResult,
  resetEntrySeq,
  skippedSummary,
  text,
  toolCall,
  toolResult,
  user,
} from "./testing/entries";
import { junctionCount, projectTree, TREE_EXCERPT_MAX, type TreeNode } from "./tree-nodes";
import { projectThread } from "./tree";
import { must } from "../testing/must";
import type { ThreadEntry } from "./types";

beforeEach(() => resetEntrySeq());

const node = (nodes: readonly TreeNode[], id: string) =>
  must(
    nodes.find((n) => n.id === id),
    id,
  );

/** Pi's settings entry at the root, then a straight conversation. */
const straight = (): ThreadEntry[] => [
  entry("r0", null, null, "thinking_level_change"),
  user("u1", "r0", "plan   the\n\nQ3 budget"),
  assistant("a1", "u1", toolCall("c1", "bash", { command: "ls" })),
  toolResult("t1", "a1", "c1", "files"),
  assistant("a1b", "t1", text("Here is the plan.")),
  user("u2", "a1b", "and Q4?"),
  assistant("a2", "u2", toolCall("c2", "bash", { command: "ls" })),
  toolResult("t2", "a2", "c2", "files"),
];

/** One prompt with three versions under the first answer (an edit made twice). */
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

describe("projectTree: nodes are projectThread's messages (ac-1)", () => {
  it("has one node per message, with projectThread's ids and parents", () => {
    for (const entries of [straight(), threeVersions()]) {
      const thread = projectThread(entries, "b2", "b3");
      const tree = projectTree(entries, "b2", "b3", null);
      expect(tree.nodes.map((n) => [n.id, n.parentId])).toEqual(
        expect.arrayContaining(thread.items.map((i) => [i.message.id, i.parentId])),
      );
      expect(tree.nodes).toHaveLength(thread.items.length);
    }
  });

  it("puts every version in the tree, not only the branch on screen", () => {
    const tree = projectTree(threeVersions(), "b3", "b3", null);
    expect(tree.nodes.map((n) => n.id)).toEqual(["u1", "a1", "v1", "b1", "v2", "b2", "v3", "b3"]);
    expect(node(tree.nodes, "v2").parentId).toBe("a1");
  });

  it("marks the path root → head on screen and the leaf apart from it", () => {
    const tree = projectTree(threeVersions(), "b2", "b3", null);
    const onScreen = tree.nodes.filter((n) => n.onScreen).map((n) => n.id);
    expect(onScreen).toEqual(["u1", "a1", "v2", "b2"]);
    expect(tree.nodes.filter((n) => n.isLeaf).map((n) => n.id)).toEqual(["b3"]);
    expect(tree.headId).toBe("b2");
    expect(tree.leafId).toBe("b3");
  });

  it("follows the head with no leaf given (the head is the leaf)", () => {
    const tree = projectTree(threeVersions(), "b1", "b1", null);
    expect(node(tree.nodes, "b1").isLeaf).toBe(true);
    expect(node(tree.nodes, "b1").onScreen).toBe(true);
    expect(node(tree.nodes, "b3").onScreen).toBe(false);
  });

  it("excerpts: whitespace collapsed, cut at 120 characters, tool-only turns named", () => {
    const long = "word ".repeat(60);
    const entries = [...straight(), user("u3", "t2", long)];
    const tree = projectTree(entries, "u3", "u3", null);
    expect(node(tree.nodes, "u1").excerpt).toBe("plan the Q3 budget");
    expect(node(tree.nodes, "a1").excerpt).toBe("Here is the plan.");
    expect(node(tree.nodes, "a2").excerpt).toBe("(tools only)");
    const cut = node(tree.nodes, "u3").excerpt;
    expect(cut).toHaveLength(TREE_EXCERPT_MAX);
    expect(cut.endsWith("…")).toBe(true);
    expect(node(tree.nodes, "u1").role).toBe("user");
    expect(node(tree.nodes, "a1").at).toBe("2026-10-02T10:00:00.000Z");
  });

  it("orders nodes by their first entry's seq", () => {
    const tree = projectTree(threeVersions(), "b3", "b3", null);
    const seqs = tree.nodes.map((n) => n.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("leaves skipped-actions reports out (they are cards, not nodes)", () => {
    const entries = [...straight(), skippedSummary("ks-r1", "t2", "skipped")];
    const tree = projectTree(entries, "ks-r1", "ks-r1", null);
    expect(tree.nodes.map((n) => n.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("puts root branches (two first messages) side by side, the leaf's on screen", () => {
    const entries = [
      entry("r0", null, null, "thinking_level_change"),
      user("u1", "r0", "first"),
      assistant("a1", "u1", text("one")),
      branchMarker("k1", "r0"),
      user("w1", "k1", "a better start"),
      assistant("x1", "w1", text("two")),
    ];
    const tree = projectTree(entries, "x1", "x1", null);
    expect(node(tree.nodes, "u1").parentId).toBeNull();
    expect(node(tree.nodes, "w1").parentId).toBeNull();
    expect(node(tree.nodes, "u1").onScreen).toBe(false);
    expect(node(tree.nodes, "w1").onScreen).toBe(true);
  });
});

describe("projectTree: ghost nodes (CT5, ac-3)", () => {
  it("draws a root edit with no message as an empty node, also when it is not the head", () => {
    const entries = [
      entry("r0", null, null, "thinking_level_change"),
      user("u1", "r0", "first"),
      assistant("a1", "u1", text("one")),
      branchMarker("k1", "r0"),
    ];
    const asHead = projectTree(entries, "k1", "k1", null);
    const elsewhere = projectTree(entries, "a1", "a1", null);
    for (const tree of [asHead, elsewhere]) {
      const ghost = node(tree.nodes, "empty:k1");
      expect(ghost.empty).toBe(true);
      expect(ghost.parentId).toBeNull();
      expect(ghost.role).toBe("assistant");
      expect(tree.nodes.filter((n) => n.id === "empty:k1")).toHaveLength(1);
    }
    expect(node(asHead.nodes, "empty:k1").onScreen).toBe(true);
    expect(node(asHead.nodes, "empty:k1").isLeaf).toBe(true);
    expect(node(elsewhere.nodes, "empty:k1").onScreen).toBe(false);
  });

  it("draws an interrupted regenerate as an empty node under its prompt", () => {
    const entries = [
      user("u1", null, "q"),
      assistant("a1", "u1", text("one")),
      branchMarker("k2", "u1"),
      modelChange("m2", "k2", "gpt-5"),
    ];
    const tree = projectTree(entries, "a1", "a1", null);
    const ghost = node(tree.nodes, "empty:k2");
    expect(ghost).toMatchObject({ parentId: "u1", empty: true, excerpt: "" });
    expect(node(tree.nodes, "a1").empty).toBeUndefined();
  });

  it("draws no ghost while the run's prompt is still on screen", () => {
    const entries = [
      user("u1", null, "q"),
      assistant("a1", "u1", text("one")),
      branchMarker("k2", "a1"),
    ];
    const tree = projectTree(entries, "k2", "k2", null, {
      run: newLiveRun("r1"),
      active: true,
      prompt: { text: "again", parentEntryId: "a1" },
    });
    expect(tree.nodes.some((n) => n.empty)).toBe(false);
  });
});

describe("projectTree: the live run (dashed)", () => {
  it("adds the pending prompt and the streaming answer as live, uncommitted nodes", () => {
    const run = {
      ...newLiveRun("r1"),
      started: true,
      startedAt: "2026-10-02T11:00:00.000Z",
      messages: [
        {
          messageId: "m1",
          parts: [{ kind: "text" as const, contentIndex: 0, text: "thinking aloud" }],
        },
      ],
    };
    const tree = projectTree(straight(), "t2", "t2", null, {
      run,
      active: true,
      prompt: { text: "next", parentEntryId: "t2" },
    });
    const prompt = node(tree.nodes, "prompt:r1");
    const live = node(tree.nodes, "live:r1");
    expect(prompt).toMatchObject({ role: "user", live: true, pending: true, excerpt: "next" });
    expect(live).toMatchObject({ parentId: "prompt:r1", live: true, pending: true });
    expect(live.excerpt).toBe("thinking aloud");
    expect(live.at).toBe("2026-10-02T11:00:00.000Z");
    expect(tree.headId).toBe("live:r1");
    expect(live.onScreen).toBe(true);
    expect(node(tree.nodes, "a2").isLeaf).toBe(true);
  });
});

describe("projectTree: notes, model, tokens, badges (CT1, CT6, ac-3)", () => {
  const worked = (): ThreadEntry[] => [
    entry("r0", null, null, "thinking_level_change"),
    user("u1", "r0", "write the report"),
    answered(
      "a1",
      "u1",
      "gpt-5",
      { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 },
      toolCall("c1", "write", { path: "report.md", content: "x" }),
      toolCall("c2", "edit", { path: "data.csv", edits: [] }),
      toolCall("c3", "edit", { path: "report.md", edits: [] }),
      toolCall("c4", "remember", { scope: "user", path: "prefs.md", content: "y" }),
      toolCall("c5", "write", { path: "failed.md", content: "z" }),
    ),
    namedResult("t1", "a1", "c1", "write"),
    namedResult("t2", "t1", "c2", "edit"),
    namedResult("t3", "t2", "c3", "edit"),
    namedResult("t4", "t3", "c4", "remember"),
    namedResult("t5", "t4", "c5", "write", true),
    answered("a1b", "t5", "gpt-5", { input: 300, output: 40 }, text("Done.")),
    compaction("cp", "a1b", "summary", "u1"),
    modelChange("m1", "cp", "claude-x"),
    user("u2", "m1", "shorter"),
    answered("a2", "u2", "claude-x", { input: 80, output: 5 }, text("Short.")),
  ];

  it("counts file writes and edits (distinct paths, failures left out) and memory writes", () => {
    const tree = projectTree(worked(), "a2", "a2", null);
    expect(node(tree.nodes, "a1").badges).toEqual({
      files: 2,
      paths: ["report.md", "data.csv"],
      memories: 1,
    });
    expect(node(tree.nodes, "u1").badges).toEqual({});
    expect(node(tree.nodes, "a2").badges).toEqual({});
  });

  it("leaves out a call with no stored result (the run stopped mid-call)", () => {
    const entries = [
      user("u1", null, "go"),
      assistant(
        "a1",
        "u1",
        toolCall("c1", "write", { path: "done.md" }),
        toolCall("c2", "write", { path: "cut.md" }),
        toolCall("c3", "remember", { path: "m.md" }),
      ),
      namedResult("t1", "a1", "c1", "write"),
    ];
    const tree = projectTree(entries, "t1", "t1", null);
    expect(node(tree.nodes, "a1").badges).toEqual({ files: 1, paths: ["done.md"] });
  });

  it("puts the remembered rule on the answer to its run's prompt", () => {
    const notes = { labels: [], runs: [{ user_entry_id: "u2", remembered_rule: true }] };
    const tree = projectTree(worked(), "a2", "a2", notes);
    expect(node(tree.nodes, "a2").badges.rule).toBe(true);
    expect(node(tree.nodes, "a1").badges.rule).toBeUndefined();
    const off = { labels: [], runs: [{ user_entry_id: "u1", remembered_rule: false }] };
    expect(node(projectTree(worked(), "a2", "a2", off).nodes, "a1").badges.rule).toBeUndefined();
  });

  it("sums Pi's usage over the answer's steps (prompt = input + cache)", () => {
    const tree = projectTree(worked(), "a2", "a2", null);
    expect(node(tree.nodes, "a1").tokens).toEqual({ input: 460, output: 60 });
    expect(node(tree.nodes, "a2").tokens).toEqual({ input: 80, output: 5 });
    expect(node(tree.nodes, "u1").tokens).toBeNull();
  });

  it("records the branch's model at each node and the compaction tick", () => {
    const tree = projectTree(worked(), "a2", "a2", null);
    expect(node(tree.nodes, "u1").model).toBeNull();
    expect(node(tree.nodes, "a1").model).toBe("gpt-5");
    expect(node(tree.nodes, "u2").model).toBe("claude-x");
    expect(node(tree.nodes, "a1").compacted).toBe(true);
    expect(node(tree.nodes, "a2").compacted).toBeUndefined();
  });

  it("puts labels on their node and an agent switch on its prompt", () => {
    const notes = {
      labels: [
        { entry_id: "u2", label: "shorter take" },
        { entry_id: "t3", label: "mid answer" },
      ],
      runs: [],
      agents: [
        { runId: "r2", userEntryId: "u2", parentEntryId: "m1", fromVersion: 1, toVersion: 2 },
      ],
      agentName: "Analyst",
    };
    const tree = projectTree(worked(), "a2", "a2", notes);
    expect(node(tree.nodes, "u2").label).toBe("shorter take");
    expect(node(tree.nodes, "a1").label).toBe("mid answer");
    expect(node(tree.nodes, "u2").agentVersion).toEqual({ name: "Analyst", version: 2 });
    expect(node(tree.nodes, "a2").agentVersion).toBeNull();
  });

  it("folds a branch summary into the node it was carried to", () => {
    const entries = [...threeVersions(), branchSummary("s1", "a1", "what the other branch did")];
    const tree = projectTree(entries, "b3", "b3", null);
    expect(node(tree.nodes, "a1").summary).toEqual({ entryId: "s1" });
    expect(tree.nodes.some((n) => n.id.includes("s1"))).toBe(false);
  });
});

describe("junctionCount (CT12)", () => {
  it("counts entries with more than one child, the root's settings entry included", () => {
    expect(junctionCount(straight())).toBe(0);
    expect(junctionCount(threeVersions())).toBe(1);
    const roots = [
      entry("r0", null, null, "thinking_level_change"),
      user("u1", "r0", "first"),
      branchMarker("k1", "r0"),
    ];
    expect(junctionCount(roots)).toBe(1);
  });

  it("leaves out a stopped answer that was regenerated (KOBE-290), as projectThread does", () => {
    const entries = [
      user("u1", null, "q"),
      entry("a0", "u1", { role: "assistant", content: [], stopReason: "aborted" }),
      assistant("a1", "u1", text("one")),
    ];
    expect(junctionCount(entries)).toBe(0);
    expect(junctionCount(entries, "a1")).toBe(0);
    expect(junctionCount(entries, "a0")).toBe(1);
  });

  it("leaves out skipped-actions reports and app cards; counts unsent prompts", () => {
    const base = [user("u1", null, "q"), assistant("a1", "u1", text("one"))];
    expect(junctionCount([...base, skippedSummary("ks-1", "a1", "s"), user("u2", "a1", "x")])).toBe(
      0,
    );
    const card = appCardEntry("ka-0123456789abcdef01234567", "a1");
    expect(junctionCount([...base, card, user("u2", "a1", "x")])).toBe(0);
    expect(junctionCount([...base, user("ku-abc", "a1", "unsent"), user("u2", "a1", "x")])).toBe(1);
  });
});
