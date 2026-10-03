import { beforeEach, describe, expect, it } from "vitest";
import { applyRunEvents, newLiveRun } from "./live";
import {
  assistant,
  entry,
  resetEntrySeq,
  text,
  toolCall,
  toolResult,
  user,
} from "./testing/entries";
import { messageMeta, projectThread, type Projection } from "./tree";
import { must } from "../testing/must";

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
