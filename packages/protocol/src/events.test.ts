import { describe, expect, it } from "vitest";
import { KOBE_EVENT_TYPES, isKobeEventType } from "./index.js";

describe("Kobe Event Stream types", () => {
  it("lists every event type from the spec (§6.2)", () => {
    expect(KOBE_EVENT_TYPES).toEqual([
      "run.queued",
      "run.started",
      "sandbox.waking",
      "text.delta",
      "reasoning.delta",
      "tool.call",
      "tool.result",
      "approval.requested",
      "approval.resolved",
      "policy.denied",
      "egress.blocked",
      "steer.applied",
      "memory.updated",
      "artifact.created",
      "artifact.updated",
      "file.shared",
      "entry.committed",
      "run.completed",
      "run.failed",
      "run.interrupted",
      "run.budget_stopped",
    ]);
  });

  it("recognises known types and rejects unknown ones", () => {
    expect(isKobeEventType("text.delta")).toBe(true);
    expect(isKobeEventType("text.deltas")).toBe(false);
    expect(isKobeEventType(42)).toBe(false);
  });
});
