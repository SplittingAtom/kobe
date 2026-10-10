import type { KobeToolsRequest, KobeToolsResponse, MemoryResultFrame } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { MemoryBroker } from "./memory-broker.js";

const THREAD = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const RUN = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f";
type Put = Extract<KobeToolsRequest, { op: "memory.put" }>;
type Read = Extract<KobeToolsRequest, { op: "memory.read" }>;
const put = (id = "kt_1"): Put => ({
  id,
  op: "memory.put",
  tool_call_id: `call_${id}`,
  input: { scope: "user", path: "a.md", content: "x" },
});
const read: Read = { id: "kt_2", op: "memory.read", tool_call_id: "call_r", input: { query: "q" } };

function setup(sendOk = true) {
  const sent: Record<string, unknown>[] = [];
  const replies: KobeToolsResponse[] = [];
  const broker = new MemoryBroker({
    send: (frame) => {
      sent.push(frame as unknown as Record<string, unknown>);
      return sendOk;
    },
  });
  return { broker, sent, replies, reply: (r: KobeToolsResponse) => replies.push(r) };
}

describe("MemoryBroker", () => {
  it("sends memory.put with the agent's own run and thread and the tool call id", () => {
    const { broker, sent, reply } = setup();
    broker.request(THREAD, RUN, put(), reply);
    expect(sent[0]).toMatchObject({
      type: "memory.put",
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_kt_1",
      input: { scope: "user", path: "a.md", content: "x" },
    });
    expect(sent[0]).not.toHaveProperty("tool");
  });

  it("sends memory.read with the recall tool call id", () => {
    const { broker, sent, reply } = setup();
    broker.request(THREAD, RUN, read, reply);
    expect(sent[0]).toMatchObject({ type: "memory.read", tool_call_id: "call_r" });
  });

  it("relays the result once, to the right request", () => {
    const { broker, sent, replies, reply } = setup();
    broker.request(THREAD, RUN, put(), reply);
    const frame: MemoryResultFrame = {
      v: 1,
      type: "memory.result",
      request_id: sent[0]?.request_id as string,
      ok: true,
      op: "put",
      status: "applied",
      scope: "user",
      path: "a.md",
      version: 1,
    };
    expect(broker.onResult(frame)).toBe(true);
    expect(replies).toEqual([
      { id: "kt_1", ok: true, op: "put", status: "applied", scope: "user", path: "a.md", version: 1 },
    ]);
    expect(broker.onResult(frame)).toBe(false);
  });

  it("fails closed without a run, without a wire, when the run ends, and when too many wait", () => {
    const a = setup();
    a.broker.request(THREAD, undefined, put(), a.reply);
    expect(a.replies[0]).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    const b = setup(false);
    b.broker.request(THREAD, RUN, put(), b.reply);
    expect(b.replies[0]).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const c = setup();
    c.broker.request(THREAD, RUN, put(), c.reply);
    c.broker.failRun(RUN, "run ended");
    expect(c.replies[0]).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const d = setup();
    for (let i = 0; i < 6; i++) d.broker.request(THREAD, RUN, put(`kt_${i}`), d.reply);
    expect(d.replies.filter((r) => !r.ok).length).toBeGreaterThan(0);
    d.broker.failThread(THREAD, "closed");
    d.broker.failAll("lost");
    expect(d.replies.length).toBe(6);
  });
});
