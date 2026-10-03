import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../policy/registry.js";
import { createRunTranslator, toolCallInput, toolResultPreview } from "./translate.js";

const TEAM = "00000000-0000-4000-8000-000000000001";
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { total: 0 },
};
const update = (assistantMessageEvent: object) => ({
  type: "message_update",
  usage,
  assistantMessageEvent,
});

function translator() {
  return createRunTranslator({ teamId: TEAM, registry: createToolRegistry() });
}

describe("Pi → Kobe translation", () => {
  it("maps text and thinking deltas onto a message id derived from the wire seq", async () => {
    const t = translator();
    await t.translate(3, { type: "message_start", message: { role: "assistant" } } as never);
    const text = await t.translate(4, update({ type: "text_delta", contentIndex: 0, delta: "Hi" }));
    const think = await t.translate(
      5,
      update({ type: "thinking_delta", contentIndex: 1, delta: "hmm" }),
    );
    expect(text.events).toEqual([
      { type: "text.delta", payload: { message_id: "m3", content_index: 0, delta: "Hi" } },
    ]);
    expect(think.events[0]?.type).toBe("reasoning.delta");
    await t.translate(6, { type: "message_end", message: { role: "assistant" } } as never);
    expect(t.takeCompletedMessageId()).toBe("m3");
    expect(t.takeCompletedMessageId()).toBeUndefined();
  });

  it("opens a message id for deltas whose message_start it never saw (resumed elsewhere)", async () => {
    const t = translator();
    const r = await t.translate(9, update({ type: "text_delta", contentIndex: 0, delta: "x" }));
    expect(r.events[0]?.payload).toMatchObject({ message_id: "m9" });
  });

  it("does not open messages for user messages", async () => {
    const t = translator();
    await t.translate(1, { type: "message_start", message: { role: "user" } } as never);
    await t.translate(2, { type: "message_end", message: { role: "user" } } as never);
    expect(t.takeCompletedMessageId()).toBeUndefined();
  });

  it("emits tool.call with the server's risk and tool.result with a capped preview", async () => {
    const t = translator();
    const call = await t.translate(1, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls" },
    } as never);
    expect(call.events).toEqual([
      {
        type: "tool.call",
        payload: {
          tool_call_id: "call_1",
          tool: "bash",
          input: { command: "ls" },
          risk: "destructive",
        },
      },
    ]);
    const unknown = await t.translate(2, {
      type: "tool_execution_start",
      toolCallId: "call_2",
      toolName: "read",
      args: {},
    } as never);
    expect(unknown.events[0]?.payload).toMatchObject({ risk: "read" });
    const end = await t.translate(3, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "out" }, { type: "image" }] },
    } as never);
    expect(end.events[0]?.payload).toEqual({
      tool_call_id: "call_1",
      tool: "bash",
      is_error: false,
      preview: "out[image]",
      truncated: false,
    });
  });

  it("asks for an entry sync at turn_end and settles on agent_settled", async () => {
    const t = translator();
    expect(
      (await t.translate(1, { type: "turn_end", message: { role: "assistant" } } as never))
        .syncEntries,
    ).toBe(true);
    const settled = await t.translate(2, { type: "agent_settled" });
    expect(settled).toMatchObject({ settled: true, syncEntries: true, events: [] });
  });

  it("ignores unknown types (incl. kobe.event_dropped) and flags malformed known ones", async () => {
    const t = translator();
    expect((await t.translate(1, { type: "kobe.event_dropped" })).events).toEqual([]);
    expect((await t.translate(2, { type: "queue_update" })).invalid).toBeUndefined();
    const bad = await t.translate(3, { type: "message_update" });
    expect(bad.invalid).toBeTruthy();
    expect(bad.events).toEqual([]);
  });

  it("drops events that would fail their schema (hostile ids)", async () => {
    const t = translator();
    const r = await t.translate(1, {
      type: "tool_execution_start",
      toolCallId: "x".repeat(200),
      toolName: "bash",
    } as never);
    expect(r.events).toEqual([]);
    expect(r.dropped).toBe(1);
  });
});

describe("tool input and preview bounds", () => {
  it("summarises unsafe or oversized inputs", () => {
    expect(toolCallInput({ a: 2 ** 60 })).toEqual({ kobe_omitted: "invalid" });
    expect(toolCallInput({ content: "x".repeat(70_000) })).toMatchObject({
      kobe_omitted: "too_large",
    });
    expect(toolCallInput(undefined)).toEqual({});
  });

  it("caps previews", () => {
    const r = toolResultPreview({ content: [{ type: "text", text: "y".repeat(40_000) }] });
    expect(r.truncated).toBe(true);
    expect(r.preview.length).toBe(16_384);
    expect(toolResultPreview("nope")).toEqual({ preview: "", truncated: false });
  });
});
