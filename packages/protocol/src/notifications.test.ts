import { describe, expect, it } from "vitest";
import {
  EVENT_PAYLOAD_SCHEMAS,
  NOTIFICATIONS_PAGE_MAX,
  NOTIFICATION_KINDS,
  SKIPPED_ACTIONS_MAX,
  listNotificationsQuerySchema,
  listNotificationsResponseSchema,
  markNotificationsReadBodySchema,
  markNotificationsReadResponseSchema,
  notificationSchema,
  runScheduleMarkerSchema,
  skippedActionSchema,
  skippedActionsSchema,
} from "./index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

const skipped = {
  tool_call_id: "tc_9",
  tool: "mcp__jira__create_issue",
  risk: "write",
  reason_code: "scheduled_run_no_prompt",
} as const;

const notification = {
  notification_id: EXAMPLE_IDS.file,
  kind: "schedule.run.skipped_actions",
  schedule_id: EXAMPLE_IDS.agent,
  thread_id: EXAMPLE_IDS.thread,
  run_id: EXAMPLE_IDS.run,
  skipped_count: 2,
  read_at: null,
  created_at: "2026-10-09T08:00:00Z",
};

describe("skipped actions", () => {
  it("accepts tool name, risk, reason code and call id", () => {
    expect(skippedActionSchema.safeParse(skipped).success).toBe(true);
  });
  it("carries no tool input or output (strict)", () => {
    expect(skippedActionSchema.safeParse({ ...skipped, input: { a: 1 } }).success).toBe(false);
    expect(skippedActionSchema.safeParse({ ...skipped, output: "x" }).success).toBe(false);
  });
  it("rejects an unknown reason code and bounds the list", () => {
    expect(skippedActionSchema.safeParse({ ...skipped, reason_code: "nope" }).success).toBe(false);
    expect(
      skippedActionsSchema.safeParse(Array(SKIPPED_ACTIONS_MAX + 1).fill(skipped)).success,
    ).toBe(false);
    expect(skippedActionsSchema.safeParse(Array(SKIPPED_ACTIONS_MAX).fill(skipped)).success).toBe(
      true,
    );
  });
});

describe("run terminal events (additive)", () => {
  const sa = [skipped];
  it("old payloads still decode", () => {
    expect(EVENT_PAYLOAD_SCHEMAS["run.completed"].safeParse({ leaf_entry_id: null }).success).toBe(
      true,
    );
    expect(
      EVENT_PAYLOAD_SCHEMAS["run.failed"].safeParse({ error: { code: "x", message: "y" } }).success,
    ).toBe(true);
    expect(
      EVENT_PAYLOAD_SCHEMAS["run.interrupted"].safeParse({
        reason: "sandbox_lost",
        last_entry_id: null,
        retryable: true,
      }).success,
    ).toBe(true);
  });
  it("accept skipped_actions", () => {
    expect(
      EVENT_PAYLOAD_SCHEMAS["run.completed"].safeParse({ leaf_entry_id: null, skipped_actions: sa })
        .success,
    ).toBe(true);
    expect(
      EVENT_PAYLOAD_SCHEMAS["run.failed"].safeParse({
        error: { code: "x", message: "y" },
        skipped_actions: sa,
      }).success,
    ).toBe(true);
    expect(
      EVENT_PAYLOAD_SCHEMAS["run.interrupted"].safeParse({
        reason: "sandbox_lost",
        last_entry_id: null,
        retryable: true,
        skipped_actions: sa,
      }).success,
    ).toBe(true);
  });
});

describe("notification", () => {
  it("pins the kinds", () => {
    expect(NOTIFICATION_KINDS).toEqual([
      "schedule.run.succeeded",
      "schedule.run.failed",
      "schedule.run.interrupted",
      "schedule.run.skipped_actions",
      "schedule.paused",
    ]);
  });
  it("parses a run notification and a pause notification", () => {
    expect(notificationSchema.safeParse(notification).success).toBe(true);
    const paused = {
      ...notification,
      kind: "schedule.paused",
      thread_id: null,
      run_id: null,
      skipped_count: undefined,
      paused_by: "team_admin",
    };
    expect(notificationSchema.safeParse(paused).success).toBe(true);
  });
  it("carries no prompt or message text", () => {
    expect(notificationSchema.safeParse({ ...notification, prompt: "secret" }).success).toBe(false);
    expect(notificationSchema.safeParse({ ...notification, body: "text" }).success).toBe(false);
  });
  it("rejects an unknown kind and a non-null read_at that is not a timestamp", () => {
    expect(notificationSchema.safeParse({ ...notification, kind: "other" }).success).toBe(false);
    expect(notificationSchema.safeParse({ ...notification, read_at: "yesterday" }).success).toBe(
      false,
    );
  });
});

describe("notification API bodies", () => {
  it("list query defaults", () => {
    expect(listNotificationsQuerySchema.parse({})).toEqual({ unread: false, limit: 50 });
    expect(listNotificationsQuerySchema.parse({ unread: "true", limit: "10" })).toMatchObject({
      unread: true,
      limit: 10,
    });
    expect(
      listNotificationsQuerySchema.safeParse({ limit: NOTIFICATIONS_PAGE_MAX + 1 }).success,
    ).toBe(false);
  });
  it("list response", () => {
    expect(
      listNotificationsResponseSchema.safeParse({
        notifications: [notification],
        unread_count: 1,
        next_cursor: null,
      }).success,
    ).toBe(true);
  });
  it("mark read: ids xor all", () => {
    const p = (v: unknown) => markNotificationsReadBodySchema.safeParse(v).success;
    expect(p({ notification_ids: [EXAMPLE_IDS.file] })).toBe(true);
    expect(p({ all: true })).toBe(true);
    expect(p({})).toBe(false);
    expect(p({ all: true, notification_ids: [EXAMPLE_IDS.file] })).toBe(false);
    expect(p({ notification_ids: [] })).toBe(false);
    expect(
      markNotificationsReadResponseSchema.safeParse({ updated: 1, unread_count: 0 }).success,
    ).toBe(true);
  });
});

describe("run schedule marker", () => {
  it("absent decodes as null; a scheduled run carries the schedule id", () => {
    expect(runScheduleMarkerSchema.parse({})).toEqual({ schedule_id: null });
    expect(runScheduleMarkerSchema.parse({ schedule_id: EXAMPLE_IDS.agent })).toEqual({
      schedule_id: EXAMPLE_IDS.agent,
    });
  });
});
