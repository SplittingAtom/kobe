import { describe, expect, it } from "vitest";
import { AGENT_HELLO_AFTER_WAKE_MAX_MS, agentHelloSpan, wakeSpans } from "./timing.js";

const T0 = 1_792_000_000_000;

describe("wakeSpans (KOBE-525)", () => {
  it("splits a wake into claim (Sandbox created or resumed) and pod-ready spans under the wake", () => {
    const spans = wakeSpans({
      startMs: T0,
      claimedMs: T0 + 1_200,
      readyMs: T0 + 4_000,
      reason: "first_start",
      resumed: false,
    });
    const attributes = { "kobe.wake.reason": "first_start", "kobe.wake.resumed": false };
    expect(spans).toEqual([
      { name: "sandbox.wake", startMs: T0, endMs: T0 + 4_000, attributes },
      { name: "sandbox.claim", startMs: T0, endMs: T0 + 1_200, attributes },
      { name: "sandbox.pod_ready", startMs: T0 + 1_200, endMs: T0 + 4_000, attributes },
    ]);
  });

  it("names a wake of a disconnected running sandbox `reconnect` and never runs backwards", () => {
    const [wake, claim, ready] = wakeSpans({
      startMs: T0,
      claimedMs: T0 + 50,
      readyMs: T0 + 10,
      reason: null,
      resumed: true,
    });
    expect(wake?.attributes["kobe.wake.reason"]).toBe("reconnect");
    expect(wake?.endMs).toBe(T0 + 50);
    expect(claim?.endMs).toBe(T0 + 50);
    expect(ready).toMatchObject({ startMs: T0 + 50, endMs: T0 + 50 });
  });
});

describe("agentHelloSpan (KOBE-525)", () => {
  it("times wake start → the agent's hello when the hello follows a recent wake", () => {
    expect(agentHelloSpan(new Date(T0), T0 + 7_000)).toEqual({
      name: "sandbox.agent_hello",
      startMs: T0,
      endMs: T0 + 7_000,
      attributes: {},
    });
  });

  it("records nothing for a reconnect long after the wake, a missing row or a clock step back", () => {
    expect(agentHelloSpan(new Date(T0), T0 + AGENT_HELLO_AFTER_WAKE_MAX_MS + 1)).toBeUndefined();
    expect(agentHelloSpan(null, T0)).toBeUndefined();
    expect(agentHelloSpan(new Date(T0 + 5), T0)).toBeUndefined();
  });
});
