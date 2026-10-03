import { describe, expect, it } from "vitest";
import { RUN_ERROR_CODES, parseEventPayload, type KobeEventType } from "@kobe/protocol";
import { RUN_ERROR_STATUS, RunError } from "./errors.js";
import { budgetStoppedEvent, cancelledEvent, failedEvent } from "./lifecycle.js";

const valid = (e: { type: string; payload: unknown }) =>
  parseEventPayload(e.type as KobeEventType, e.payload);

describe("orchestrator events", () => {
  it("writes run.* payloads that pass their protocol schemas", () => {
    for (const code of ["timeout", "account_inactive", "agent_unavailable", "start_lost"]) {
      expect(valid(failedEvent(code))).toMatchObject({ error: { code } });
    }
    expect(
      valid(
        cancelledEvent({
          id: "t",
          ownerUserId: "u",
          status: "running",
          leafEntryId: "abc",
          agentScope: null,
          agentId: null,
          agentVersion: null,
          deletedAt: null,
        }),
      ),
    ).toEqual({ reason: "cancelled", last_entry_id: "abc", retryable: false });
    for (const scope of ["install", "team", "user"] as const) {
      expect(valid(budgetStoppedEvent(scope))).toMatchObject({ scope });
    }
  });

  it("never shows a sandbox-supplied error code or text", () => {
    const event = failedEvent("<script>untrusted</script>");
    expect(event.payload).toEqual({
      error: { code: "start_failed", message: "The run could not start in your workspace." },
    });
  });
});

describe("orchestrator errors", () => {
  it("maps every contract error code to an HTTP status", () => {
    for (const code of RUN_ERROR_CODES) expect(RUN_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(new RunError("run_not_found").status).toBe(404);
    expect(new RunError("thread_busy").status).toBe(409);
    expect(new RunError("isolation_unavailable").message).toMatch(/isolation/);
  });
});
