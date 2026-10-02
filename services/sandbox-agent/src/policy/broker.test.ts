import type { PolicyCheckFrame } from "@kobe/protocol";
import { EXAMPLE_IDS } from "@kobe/protocol/testing";
import { describe, expect, it } from "vitest";
import {
  MAX_PENDING_POLICY_CHECKS,
  MAX_PENDING_POLICY_CHECKS_PER_THREAD,
  PolicyBroker,
} from "./broker.js";
import type { PolicyChannelCheck, PolicyChannelReply } from "./channel.js";

const T = EXAMPLE_IDS.thread;
const R = EXAMPLE_IDS.run;
const check = (id = "ext-1"): PolicyChannelCheck => ({
  type: "policy.check",
  nonce: "n",
  request_id: id,
  tool_call_id: "call_1",
  tool: "bash",
  input: { command: "ls" },
});

function setup(connected = true) {
  const sent: PolicyCheckFrame[] = [];
  const replies: PolicyChannelReply[] = [];
  const broker = new PolicyBroker({
    send: (frame) => {
      if (connected) sent.push(frame);
      return connected;
    },
  });
  return { broker, sent, replies, reply: (m: PolicyChannelReply) => replies.push(m) };
}

describe("PolicyBroker", () => {
  it("adds run and thread ids itself and mints its own request ids", () => {
    const { broker, sent, reply } = setup();
    broker.check(T, R, check("ext-1"), reply);
    broker.check(T, R, check("ext-1"), reply);
    expect(sent.map((f) => f.request_id)).toEqual(["pc_1", "pc_2"]);
    expect(sent[0]).toMatchObject({
      run_id: R,
      thread_id: T,
      tool: "bash",
      tool_call_id: "call_1",
    });
  });

  it("relays pending (informational) then the result, with the extension's request id", () => {
    const { broker, sent, replies, reply } = setup();
    broker.check(T, R, check("ext-9"), reply);
    const id = sent[0]?.request_id ?? "";
    expect(broker.onPending({ request_id: id, approval_id: EXAMPLE_IDS.approval })).toBe(true);
    expect(broker.onResult({ v: 1, request_id: id, decision: "allow", reasons: [] })).toBe(true);
    expect(broker.onResult({ request_id: id, decision: "allow" })).toBe(false);
    expect(replies).toEqual([
      { request_id: "ext-9", approval_id: EXAMPLE_IDS.approval },
      { request_id: "ext-9", decision: "allow", reasons: [] },
    ]);
  });

  it("denies locally without an active run or a connection (fail closed)", () => {
    const offline = setup(false);
    offline.broker.check(T, R, check(), offline.reply);
    offline.broker.check(T, undefined, check("ext-2"), offline.reply);
    expect(offline.replies.map((r) => [r.request_id, r.decision])).toEqual([
      ["ext-1", "deny"],
      ["ext-2", "deny"],
    ]);
    expect(offline.broker.pendingCount).toBe(0);
  });

  it("denies every pending check when the connection or run is lost", () => {
    const { broker, replies, reply } = setup();
    broker.check(T, R, check("a"), reply);
    broker.check(T, EXAMPLE_IDS.otherTeam, check("b"), reply);
    broker.failRun(R, "run ended");
    expect(replies).toEqual([
      {
        type: "policy.result",
        request_id: "a",
        decision: "deny",
        reasons: [],
        message: "run ended",
      },
    ]);
    broker.failAll("lost");
    expect(replies.at(-1)).toMatchObject({ request_id: "b", decision: "deny", message: "lost" });
    expect(broker.pendingCount).toBe(0);
  });

  it("bounds pending checks per thread and overall", () => {
    const { broker, replies, reply } = setup();
    for (let i = 0; i <= MAX_PENDING_POLICY_CHECKS_PER_THREAD; i++) {
      broker.check(T, R, check(`x${i}`), reply);
    }
    expect(broker.pendingCount).toBe(MAX_PENDING_POLICY_CHECKS_PER_THREAD);
    expect(replies).toEqual([
      expect.objectContaining({
        request_id: `x${MAX_PENDING_POLICY_CHECKS_PER_THREAD}`,
        decision: "deny",
      }),
    ]);
    let thread = 0;
    while (broker.pendingCount < MAX_PENDING_POLICY_CHECKS) {
      const id = `00000000-0000-4000-8000-${String(thread++).padStart(12, "0")}`;
      for (let i = 0; i < MAX_PENDING_POLICY_CHECKS_PER_THREAD; i++)
        broker.check(id, R, check(), reply);
    }
    broker.check("00000000-0000-4000-8000-999999999999", R, check("last"), reply);
    expect(broker.pendingCount).toBe(MAX_PENDING_POLICY_CHECKS);
    expect(replies.at(-1)).toMatchObject({ request_id: "last", decision: "deny" });
  });
});
