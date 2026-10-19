import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { errorAttempt, executionFromAttempts, retries, type EvalAttempt } from "./execution.js";

const attempt = (over: Partial<EvalAttempt> = {}): EvalAttempt => ({
  status: "passed",
  checks: [{ check: "max_turns", passed: true }],
  skillUses: 1,
  costUsd: 0.1,
  judgeCostUsd: 0,
  durationMs: 1000,
  turns: 2,
  deniedToolCalls: 0,
  threadId: randomUUID(),
  runId: randomUUID(),
  ...over,
});

const SMART = { requested: null, used: "smart", fellBack: false };

describe("executionFromAttempts (KOBE-325)", () => {
  it("reports the suite's model on the case when the team hasn't enabled it (KOBE-326)", () => {
    const fellBack = { requested: "huge", used: "smart", fellBack: true };
    expect(executionFromAttempts("a", true, fellBack, [attempt({})])).toMatchObject({
      model: "smart",
      requestedModel: "huge",
    });
    expect(executionFromAttempts("a", true, SMART, [attempt({})])).not.toHaveProperty(
      "requestedModel",
    );
  });

  it("reports the final attempt and totals both", () => {
    const first = attempt({
      status: "failed",
      checks: [{ check: "max_turns", passed: false, reason: "over_limit" }],
      costUsd: 0.2,
      judgeCostUsd: 0.01,
      durationMs: 3000,
    });
    const second = attempt({ judgeCostUsd: 0.02 });
    const e = executionFromAttempts("a", true, SMART, [first, second]);
    expect(e).toMatchObject({
      status: "passed",
      attempts: 2,
      costUsd: 0.1,
      totalCostUsd: 0.3,
      judgeCostUsd: 0.03,
      durationMs: 1000,
      totalDurationMs: 4000,
      triggered: true,
      threadId: second.threadId,
    });
  });

  it("derives triggered: null without the skill and after an error", () => {
    expect(executionFromAttempts("a", false, SMART, [attempt({ skillUses: 0 })]).triggered).toBe(
      null,
    );
    expect(executionFromAttempts("a", true, SMART, [errorAttempt(null, null, 5)]).triggered).toBe(
      null,
    );
  });

  it("retries once, only after a first attempt that did not pass", () => {
    expect(retries(attempt(), 1)).toBe(false);
    expect(retries(attempt({ status: "timed_out", checks: [] }), 1)).toBe(true);
    expect(retries(attempt({ status: "error", checks: [] }), 2)).toBe(false);
  });
});
