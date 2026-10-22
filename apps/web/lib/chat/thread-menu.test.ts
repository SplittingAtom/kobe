import { beforeEach, describe, expect, it } from "vitest";
import {
  assistant,
  entry,
  resetEntrySeq,
  text,
  toolCall,
  toolResult,
  user,
} from "./testing/entries";
import { initialThreadState, type ThreadState } from "./thread-state";
import { lastAnswerPoint, regenerateBlocker, threadMarkdown, visibleBranch } from "./thread-menu";
import { projectThread } from "./tree";
import type { ThreadSummary } from "./types";

/** KOBE-292: what the rail's thread menu copies and regenerates. */
beforeEach(() => resetEntrySeq());

/** Two versions of the answer: v1 (a1) and, from the same prompt, v2 (a2). */
function twoVersions() {
  return [
    entry("root", null, null, "thinking_level_change"),
    user("u1", "root", "make a chart"),
    assistant("a1", "u1", text("Version one")),
    user("u2", "root", "make a chart"),
    assistant("a2", "u2", text("Running code"), toolCall("tc1", "bash", { cmd: "python" })),
    toolResult("r1", "a2", "tc1", "ok"),
    assistant("a3", "r1", text("Here is the chart.")),
  ];
}

describe("visibleBranch / threadMarkdown", () => {
  it("copies the branch on screen only, as Markdown with the title, text parts only", () => {
    const p = projectThread(twoVersions(), "a3");
    expect(visibleBranch(p).map((i) => i.message.role)).toEqual(["user", "assistant"]);
    expect(threadMarkdown("Budget", p).markdown).toBe(
      [
        "# Budget",
        "",
        "## You",
        "",
        "make a chart",
        "",
        "## Assistant",
        "",
        "Running code",
        "",
        "Here is the chart.",
        "",
      ].join("\n"),
    );
  });

  it("follows the leaf: the other version is copied when it is the one shown", () => {
    const md = threadMarkdown("Budget", projectThread(twoVersions(), "a1")).markdown;
    expect(md).toContain("Version one");
    expect(md).not.toContain("Here is the chart.");
  });

  it("an empty conversation is its title alone", () => {
    expect(threadMarkdown("Untitled conversation", projectThread([], null))).toEqual({
      markdown: "# Untitled conversation\n",
      partial: false,
    });
  });
});

describe("lastAnswerPoint", () => {
  it("is the last answer's prompt and its parent entry (the branch point Regenerate uses)", () => {
    expect(lastAnswerPoint(projectThread(twoVersions(), "a3"))).toEqual({
      parentEntryId: "root",
      promptEntryId: "u2",
      text: "make a chart",
    });
  });

  it("is undefined without an answer", () => {
    expect(lastAnswerPoint(projectThread([user("u1", null, "hi")], "u1"))).toBeUndefined();
    expect(lastAnswerPoint(projectThread([], null))).toBeUndefined();
  });

  it("is undefined when the prompt has nothing above it to branch from", () => {
    const entries = [user("u1", null, "hi"), assistant("a1", "u1", text("hello"))];
    expect(lastAnswerPoint(projectThread(entries, "a1"))).toBeUndefined();
  });
});

describe("regenerateBlocker", () => {
  const idle: ThreadState = {
    ...initialThreadState("t1"),
    phase: "ready",
    summary: { threadId: "t1", model: null, deletedAt: null } as unknown as ThreadSummary,
  };

  it("is null for an idle thread out of Trash", () => {
    expect(regenerateBlocker(idle)).toBeNull();
  });

  it.each<[string, Partial<ThreadState>, string]>([
    ["loading", { phase: "loading" }, "Opening the conversation…"],
    ["unreadable", { phase: "error" }, "The conversation could not be read."],
    [
      "read-only",
      { summary: { ...idle.summary, readOnly: true } as ThreadSummary },
      "This conversation is shared with you read-only.",
    ],
    [
      "in Trash",
      { summary: { ...idle.summary, deletedAt: "2026-10-14" } as ThreadSummary },
      "Restore the conversation first.",
    ],
    [
      "a run going",
      { runs: [{ runId: "r1", threadId: "t1", status: "running", trigger: "user" }] },
      "Wait for the current run to finish.",
    ],
    [
      "the summary says running (runs not read yet)",
      { summary: { ...idle.summary, status: "running" } as ThreadSummary },
      "Wait for the current run to finish.",
    ],
    [
      "a run queued",
      { runs: [{ runId: "r1", threadId: "t1", status: "queued", trigger: "user" }] },
      "Wait for the current run to finish.",
    ],
    [
      "a message being sent",
      { sending: { key: "k", text: "q", parentEntryId: null, queues: false } },
      "Wait for the current run to finish.",
    ],
    ["a model change", { busy: ["model"] }, "Changing the model…"],
  ])("names why when %s", (_name, change, reason) => {
    expect(regenerateBlocker({ ...idle, ...change })).toBe(reason);
  });
});
