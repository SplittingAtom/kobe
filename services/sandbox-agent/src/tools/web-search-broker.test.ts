import type { KobeToolsRequest, KobeToolsResponse, WebSearchResultFrame } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { WebSearchBroker } from "./web-search-broker.js";

const THREAD = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const RUN = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f";
type Req = Extract<KobeToolsRequest, { op: "web_search" }>;
const request = (id = "kt_1"): Req => ({
  id,
  op: "web_search",
  tool_call_id: `call_${id}`,
  tool: "web_search",
  input: { query: "q" },
});

function setup(sendOk = true) {
  const sent: Record<string, unknown>[] = [];
  const replies: KobeToolsResponse[] = [];
  const broker = new WebSearchBroker({
    send: (frame) => {
      sent.push(frame as unknown as Record<string, unknown>);
      return sendOk;
    },
  });
  return { broker, sent, replies, reply: (r: KobeToolsResponse) => replies.push(r) };
}

describe("WebSearchBroker", () => {
  it("sends web_search.query with the agent's own run and thread, then relays the result", () => {
    const { broker, sent, replies, reply } = setup();
    broker.query(THREAD, RUN, request(), reply);
    expect(sent[0]).toMatchObject({
      type: "web_search.query",
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_kt_1",
      input: { query: "q" },
    });
    const frame: WebSearchResultFrame = {
      v: 1,
      type: "web_search.result",
      request_id: sent[0]?.request_id as string,
      ok: true,
      available: false,
      reason: "not_configured",
      message: "off",
    };
    expect(broker.onResult(frame)).toBe(true);
    expect(replies).toEqual([
      { id: "kt_1", ok: true, available: false, reason: "not_configured", message: "off" },
    ]);
    expect(broker.onResult(frame)).toBe(false);
  });

  it("fails closed without a run, without a wire, and when the run ends", () => {
    const a = setup();
    a.broker.query(THREAD, undefined, request(), a.reply);
    expect(a.replies[0]).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    const b = setup(false);
    b.broker.query(THREAD, RUN, request(), b.reply);
    expect(b.replies[0]).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const c = setup();
    c.broker.query(THREAD, RUN, request(), c.reply);
    c.broker.failRun(RUN, "run ended");
    expect(c.replies[0]).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
