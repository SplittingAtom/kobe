import type { PolicyDecision } from "@kobe/protocol";
import { describe, expect, it, vi } from "vitest";
import { retryEvaluation, type Evaluated } from "./policy-check.js";

const INPUT = {} as never;
const allow: Evaluated = {
  input: INPUT,
  decision: { effect: "allow", risk: "read", reasons: [] } as PolicyDecision,
};
const internalError: Evaluated = {
  input: INPUT,
  decision: {
    effect: "deny",
    risk: "write",
    reasons: [
      {
        code: "policy_error",
        stage: "install_deny",
        message: "Policy could not be evaluated, so the call was denied. Try again.",
      },
    ],
  } as PolicyDecision,
};
const ruleDeny: Evaluated = {
  input: INPUT,
  decision: {
    effect: "deny",
    risk: "write",
    reasons: [{ code: "rule_deny", stage: "install_deny", message: "No." }],
  } as unknown as PolicyDecision,
};

describe("retryEvaluation (KOBE-242)", () => {
  it("retries once after a thrown error and returns the second answer", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("pool timeout")).mockResolvedValue(allow);
    const onError = vi.fn();
    expect(await retryEvaluation(run, 0, onError)).toBe(allow);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("retries the engine's own internal-error deny once", async () => {
    const run = vi.fn().mockResolvedValueOnce(internalError).mockResolvedValue(allow);
    expect(await retryEvaluation(run, 0, vi.fn())).toBe(allow);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails closed after the second failure (throws, or keeps the deny)", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("down"));
    await expect(retryEvaluation(boom, 0, vi.fn())).rejects.toThrow("down");
    expect(boom).toHaveBeenCalledTimes(2);
    const still = vi.fn().mockResolvedValue(internalError);
    expect(await retryEvaluation(still, 0, vi.fn())).toBe(internalError);
    expect(still).toHaveBeenCalledTimes(2);
  });

  it("does not retry a real policy decision", async () => {
    const run = vi.fn().mockResolvedValue(ruleDeny);
    expect(await retryEvaluation(run, 0, vi.fn())).toBe(ruleDeny);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
