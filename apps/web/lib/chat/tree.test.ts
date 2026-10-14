import { beforeEach, describe, expect, it } from "vitest";
import { applyRunEvents, newLiveRun } from "./live";
import {
  assistant,
  entry,
  resetEntrySeq,
  skippedSummary,
  text,
  toolCall,
  toolResult,
  user,
} from "./testing/entries";
import { messageMeta, projectThread, type Projection } from "./tree";
import { must } from "../testing/must";
import type { ThreadEntry } from "./types";

beforeEach(() => resetEntrySeq());

function shape(p: Projection) {
  return p.items.map((i) => [i.message.id, i.parentId, i.message.role]);
}

function content(p: Projection, id: string) {
  return p.items.find((i) => i.message.id === id)?.message.content;
}

describe("projectThread", () => {
  it("folds a Pi turn (assistant steps and tool results) into one assistant message", () => {
    const entries = [
      user("u1", null, "make a chart"),
      assistant("a1", "u1", text("Running code"), toolCall("tc1", "bash", { cmd: "python" })),
      toolResult("r1", "a1", "tc1", "ok"),
      assistant("a2", "r1", text("Done")),
    ];
    const p = projectThread(entries, "a2");
    expect(shape(p)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
    ]);
    expect(p.headId).toBe("a1");
    expect(content(p, "a1")).toEqual([
      { type: "text", text: "Running code" },
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "bash",
        args: { cmd: "python" },
        argsText: '{"cmd":"python"}',
        result: "ok",
        isError: false,
      },
      { type: "text", text: "Done" },
    ]);
    expect(p.nodeOfEntry.get("r1")).toBe("a1");
    expect(p.lastEntryOfNode.get("a1")).toBe("a2");
  });

  it("keeps edit-and-regenerate branches as siblings and puts the head on the leaf's branch", () => {
    const entries = [
      user("u1", null, "first"),
      assistant("a1", "u1", text("answer 1")),
      user("u2", "a1", "question"),
      assistant("a2", "u2", text("answer 2")),
      user("u2b", "a1", "question, edited"),
      assistant("a2b", "u2b", text("answer 2b")),
    ];
    const onEdited = projectThread(entries, "a2b");
    expect(shape(onEdited)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
      ["u2", "a1", "user"],
      ["a2", "u2", "assistant"],
      ["u2b", "a1", "user"],
      ["a2b", "u2b", "assistant"],
    ]);
    expect(onEdited.headId).toBe("a2b");
    expect(projectThread(entries, "a2").headId).toBe("a2");
    const meta = messageMeta(must(onEdited.items[4]).message);
    expect(meta).toMatchObject({
      kind: "user",
      entryId: "u2b",
      parentEntryId: "a1",
      text: "question, edited",
    });
  });

  it("ends an assistant message where the tree branches inside a turn", () => {
    const entries = [
      user("u1", null, "q"),
      assistant("a1", "u1", toolCall("tc1", "read")),
      toolResult("r1", "a1", "tc1", "x"),
      assistant("a2", "r1", text("one way")),
      assistant("a2b", "r1", text("another way")),
    ];
    const p = projectThread(entries, "a2b");
    expect(shape(p)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
      ["a2", "a1", "assistant"],
      ["a2b", "a1", "assistant"],
    ]);
    expect(p.headId).toBe("a2b");
  });

  it("hides non-message entries but keeps their place in the tree", () => {
    const entries = [
      entry("m0", null, null, "model_change"),
      user("u1", "m0", "hi"),
      assistant("a1", "u1", text("hello")),
      entry("c1", "a1", null, "compaction"),
      user("u2", "c1", "again"),
    ];
    const p = projectThread(entries, "u2");
    expect(shape(p)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
      ["u2", "a1", "user"],
    ]);
    // An edit of the first message branches from the model_change entry, not from nothing.
    expect(messageMeta(must(p.items[0]).message)).toMatchObject({ parentEntryId: "m0" });
    expect(p.lastEntryOfNode.get("a1")).toBe("c1");
  });

  it("never puts the head on another branch when the leaf is a hidden entry", () => {
    const entries = [
      user("u1", null, "q"),
      assistant("a1", "u1", text("one")),
      user("u2", "a1", "branch A"),
      user("u3", "a1", "branch B"),
      entry("x", "u2", null, "label"),
    ];
    // "x" is hidden and belongs to u2's message; an unknown leaf falls back to the last message.
    expect(projectThread(entries, "x").headId).toBe("u2");
  });

  it("marks offloaded bodies and model errors", () => {
    const offloaded = { ...assistant("a1", "u1"), payload: {}, payloadOffloaded: true };
    const failed = entry("a2", "a1", {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Provider returned 529",
    });
    const p = projectThread([user("u1", null, "q"), offloaded, failed], "a2");
    expect(content(p, "a1")).toEqual([
      { type: "data-kobe-offloaded", data: { entryId: "a1" } },
      { type: "data-kobe-problem", data: { reason: "error", message: "Provider returned 529" } },
    ]);
  });

  it("marks a reply cut off at the model's output limit (KOBE-258)", () => {
    const cut = entry("a1", "u1", {
      role: "assistant",
      content: [{ type: "thinking", thinking: "<html>" }],
      stopReason: "length",
    });
    const p = projectThread([user("u1", null, "q"), cut], "a1");
    expect(content(p, "a1")).toContainEqual({
      type: "data-kobe-problem",
      data: {
        reason: "length",
        message: "The model hit its output limit here, so this reply is incomplete.",
      },
    });
  });

  it("never throws on malformed payloads", () => {
    const junk = [
      entry("x1", null, { role: "assistant", content: "plain string" }),
      entry("x2", "x1", { role: "assistant", content: [null, 3, { type: "toolCall" }] }),
      entry("x3", "x2", { role: 7 }),
      { ...entry("x4", "x3", null), payload: { message: "nope" } },
    ];
    expect(() => projectThread(junk, "x4")).not.toThrow();
  });

  it("handles a long linear thread without recursion", () => {
    const entries = [];
    let parent: string | null = null;
    for (let i = 0; i < 5000; i++) {
      const id = `e${i}`;
      entries.push(i % 2 === 0 ? user(id, parent, `q${i}`) : assistant(id, parent, text(`a${i}`)));
      parent = id;
    }
    const p = projectThread(entries, parent);
    expect(p.items).toHaveLength(5000);
    expect(p.headId).toBe("e4999");
  });
});

describe("projectThread with a scheduled run's skipped-actions summary (KOBE-178/181)", () => {
  const summaryText =
    "Skipped actions\nThis scheduled run does not wait for approval, so 1 tool call was skipped:\n- bash (changes data): scheduled runs cannot ask";

  it("shows the summary as a card at the end of the run's answer, never as its own message", () => {
    const entries = [
      user("u1", null, "nightly"),
      assistant("a1", "u1", toolCall("tc1", "bash")),
      toolResult("r1", "a1", "tc1", "denied", true),
      assistant("a2", "r1", text("Could not write")),
      skippedSummary("ks-1", "a2", summaryText, 1),
    ];
    const p = projectThread(entries, "a2");
    expect(shape(p)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
    ]);
    expect(content(p, "a1")?.at(-1)).toEqual({
      type: "data-kobe-skipped",
      data: { text: summaryText, count: 1 },
    });
    expect(p.headId).toBe("a1");
  });

  it("is never a branch point: no branch beside a reply, and no entry to continue from", () => {
    const entries = [
      user("u1", null, "nightly"),
      assistant("a1", "u1", text("done")),
      skippedSummary("ks-1", "a1", summaryText, 2),
      user("u2", "a1", "thanks"),
      assistant("a2", "u2", text("welcome")),
    ];
    const p = projectThread(entries, "a2");
    expect(shape(p)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
      ["u2", "a1", "user"],
      ["a2", "u2", "assistant"],
    ]);
    expect(p.lastEntryOfNode.get("a1")).toBe("a1");
    expect(p.nodeOfEntry.has("ks-1")).toBe(false);
    expect([...p.lastEntryOfNode.values()]).not.toContain("ks-1");
  });

  it("shows a failed run's summary under the prompt when the run left no answer", () => {
    const entries = [user("u1", null, "nightly"), skippedSummary("ks-1", "u1", summaryText, 1)];
    const p = projectThread(entries, "u1");
    expect(shape(p)).toEqual([["u1", null, "user"]]);
    expect(messageMeta(must(p.items[0]).message)).toMatchObject({
      kind: "user",
      skipped: [{ text: summaryText, count: 1 }],
    });
    expect(p.headId).toBe("u1");
  });

  it("shows a summary under a hidden root as the only message", () => {
    const entries = [
      entry("r0", null, null, "model_change"),
      skippedSummary("ks-1", "r0", summaryText),
    ];
    const p = projectThread(entries, "r0");
    expect(shape(p)).toEqual([["skipped:ks-1", null, "assistant"]]);
    expect(content(p, "skipped:ks-1")).toEqual([
      { type: "data-kobe-skipped", data: { text: summaryText, count: 1 } },
    ]);
    expect(p.headId).toBe("skipped:ks-1");
  });

  it("recognises an offloaded summary by its server id: still a card, never a branch", () => {
    const offloaded = {
      ...skippedSummary("ks-2", "a1", summaryText),
      payload: {},
      payloadOffloaded: true,
    };
    const entries = [
      user("u1", null, "nightly"),
      assistant("a1", "u1", text("done")),
      offloaded,
      user("u2", "a1", "thanks"),
      assistant("a2", "u2", text("welcome")),
    ];
    const p = projectThread(entries, "a2");
    expect(shape(p)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
      ["u2", "a1", "user"],
      ["a2", "u2", "assistant"],
    ]);
    expect(content(p, "a1")?.at(-1)).toEqual({
      type: "data-kobe-skipped",
      data: { text: "", count: 0 },
    });
    expect(p.lastEntryOfNode.get("a1")).toBe("a1");
  });

  it("drops a summary whose parent is not loaded", () => {
    const entries = [user("u1", null, "q"), skippedSummary("ks-1", "gone", summaryText)];
    const p = projectThread(entries, "u1");
    expect(shape(p)).toEqual([["u1", null, "user"]]);
  });
});

describe("projectThread with a live run", () => {
  const history = () => [user("u1", null, "q1"), assistant("a1", "u1", text("a1"))];

  it("shows the prompt Pi hasn't committed and the text still streaming, as the head", () => {
    const { run } = applyRunEvents(newLiveRun("r1"), [
      {
        run_id: "r1",
        seq: 1,
        ts: "2026-10-02T10:00:00Z",
        type: "run.started",
        payload: {
          thread_id: "00000000-0000-4000-8000-000000000001",
          agent_id: null,
          agent_version: null,
        },
      },
      {
        run_id: "r1",
        seq: 2,
        ts: "2026-10-02T10:00:00Z",
        type: "text.delta",
        payload: { message_id: "m1", content_index: 0, delta: "Hel" },
      },
      {
        run_id: "r1",
        seq: 3,
        ts: "2026-10-02T10:00:00Z",
        type: "text.delta",
        payload: { message_id: "m1", content_index: 0, delta: "lo" },
      },
    ]);
    const p = projectThread(history(), "a1", {
      run,
      active: true,
      prompt: { text: "q2", parentEntryId: "a1" },
    });
    expect(shape(p).slice(2)).toEqual([
      ["prompt:r1", "a1", "user"],
      ["live:r1", "prompt:r1", "assistant"],
    ]);
    expect(p.headId).toBe("live:r1");
    expect(content(p, "live:r1")).toEqual([{ type: "text", text: "Hello" }]);
    expect(p.items.at(-1)?.message.status).toEqual({ type: "running" });
  });

  it("continues the committed assistant message of the run instead of starting a new one", () => {
    const entries = [...history(), user("u2", "a1", "q2"), assistant("a2", "u2", text("step 1"))];
    const run = {
      ...newLiveRun("r1"),
      started: true,
      committed: ["u2", "a2"],
      promptCommitted: true,
      messages: [
        { messageId: "m2", parts: [{ kind: "text" as const, contentIndex: 0, text: "step 2" }] },
      ],
    };
    const p = projectThread(entries, "a1", { run, active: true });
    expect(p.headId).toBe("a2");
    expect(content(p, "a2")).toEqual([
      { type: "text", text: "step 1" },
      { type: "text", text: "step 2" },
    ]);
    expect(p.items.find((i) => i.message.id === "a2")?.message.status).toEqual({ type: "running" });
  });
});

describe("rich history (KOBE-208)", () => {
  const at = (s: number) => `2026-10-02T10:00:${String(s).padStart(2, "0")}.000Z`;
  /** An entry as Pi stamps it: the entry's `timestamp`, a step's start on its message. */
  function stamped(e: ThreadEntry, end: number, start?: number): ThreadEntry {
    const message = e.payload.message as Record<string, unknown>;
    return {
      ...e,
      payload: {
        ...e.payload,
        timestamp: at(end),
        message: start === undefined ? message : { ...message, timestamp: Date.parse(at(start)) },
      },
    };
  }
  const offloaded = (entryId: string, parentId: string, created: number): ThreadEntry => ({
    entryId,
    parentId,
    seq: 50,
    type: "message",
    payload: {},
    payloadOffloaded: true,
    createdAt: at(created),
  });

  it("times reasoning by its step and tool calls from the call to the result", () => {
    const entries = [
      user("u1", null, "go"),
      stamped(
        assistant("a1", "u1", { type: "thinking", thinking: "Plan" }, toolCall("tc1", "bash")),
        4,
        1,
      ),
      stamped(toolResult("r1", "a1", "tc1", "ok"), 7),
    ];
    const parts = must(content(projectThread(entries, "r1"), "a1")) as readonly Record<
      string,
      unknown
    >[];
    expect(parts[0]).toMatchObject({
      type: "reasoning",
      timing: { startedAt: Date.parse(at(1)), completedAt: Date.parse(at(4)) },
    });
    expect(parts[1]).toMatchObject({
      type: "tool-call",
      result: "ok",
      timing: { startedAt: Date.parse(at(4)), completedAt: Date.parse(at(7)) },
    });
  });

  it("hands an offloaded tool result to its card instead of a notice", () => {
    const entries = [
      user("u1", null, "go"),
      stamped(assistant("a1", "u1", toolCall("tc1", "bash")), 2),
      offloaded("o1", "a1", 9),
      assistant("a2", "o1", text("Done")),
    ];
    const p = projectThread(entries, "a2");
    const item = must(p.items.find((i) => i.message.id === "a1"));
    expect(item.message.content).toEqual([
      expect.objectContaining({ type: "tool-call", toolCallId: "tc1" }),
      { type: "text", text: "Done" },
    ]);
    expect("result" in must((item.message.content as readonly object[])[0])).toBe(false);
    expect(messageMeta(item.message)).toMatchObject({
      kind: "assistant",
      offloaded: { tc1: "o1" },
      at: "2026-10-02T10:00:00.000Z",
    });
  });
});
