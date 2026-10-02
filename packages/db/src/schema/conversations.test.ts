import { describe, expect, it } from "vitest";
import { eventStatus } from "./events.js";
import {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  runStatus,
  runTrigger,
  type RunStatus,
} from "./runs.js";
import { threadStatus } from "./threads.js";

// Enum values are the spec §5.4 state machines; changing one is a migration and a contract change.
describe("conversation enums (spec §5.4)", () => {
  it("has the thread statuses", () => {
    expect(threadStatus.enumValues).toEqual(["idle", "running", "interrupted"]);
  });

  it("has the run triggers and statuses", () => {
    expect(runTrigger.enumValues).toEqual(["user", "schedule"]);
    expect(runStatus.enumValues).toEqual([
      "queued",
      "running",
      "waiting_approval",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "budget_stopped",
    ]);
  });

  it("has the event statuses", () => {
    expect(eventStatus.enumValues).toEqual(["pending", "processed", "failed", "scheduled"]);
  });

  it("splits run statuses into queued, active and terminal", () => {
    const all: RunStatus[] = ["queued", ...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES];
    expect([...all].sort()).toEqual([...runStatus.enumValues].sort());
    expect(ACTIVE_RUN_STATUSES).toEqual(["running", "waiting_approval"]);
  });
});
