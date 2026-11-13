import { describe, expect, it } from "vitest";
import {
  EVENT_PAYLOAD_SCHEMAS,
  MEMORY_NOTIFICATION_KINDS,
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
      "skill.member_add.blocked",
      "skill.deprecated",
      "skill.version.deprecated",
      "skill.version.withdrawn",
      "skill.version.revoked",
      "skill.version.unrevoked",
      "skill.version.site_published",
      "team.member.added",
      "team.site_admin.member_added",
      "team.site_admin.member_role_changed",
      "team.site_admin.member_removed",
      "team.site_admin.member_taken_over",
      ...MEMORY_NOTIFICATION_KINDS,
    ]);
  });
  describe("memory kinds (KOBE-645)", () => {
    const memory = {
      ...notification,
      schedule_id: null,
      thread_id: null,
      run_id: null,
      skipped_count: undefined,
    };
    const object = EXAMPLE_IDS.agent;
    const project = EXAMPLE_IDS.thread;
    const ok = (n: Record<string, unknown>) => notificationSchema.safeParse(n).success;
    it("parses every memory kind with what it names", () => {
      expect(ok({ ...memory, kind: "memory.scope.near_full", memory_scope: "team" })).toBe(true);
      expect(
        ok({
          ...memory,
          kind: "memory.review.digest",
          related_kind: "memory.proposal.received",
          item_count: 6,
        }),
      ).toBe(true);
      expect(ok({ ...memory, kind: "memory.review.reminder", memory_object_id: object })).toBe(
        true,
      );
      expect(
        ok({
          ...memory,
          kind: "memory.review.candidates_ready",
          thread_id: EXAMPLE_IDS.thread,
          item_count: 3,
        }),
      ).toBe(true);
      expect(
        ok({
          ...memory,
          kind: "memory.review.reminder",
          memory_object_id: object,
          related_kind: "memory.site_proposal.confirmed",
        }),
      ).toBe(true);
      expect(ok({ ...memory, kind: "memory.proposal.expired", memory_object_id: object })).toBe(
        true,
      );
      expect(
        ok({
          ...memory,
          kind: "memory.review.reminder",
          memory_object_id: object,
          related_kind: "memory.suggestion.received",
          project_id: project,
        }),
      ).toBe(true);
      expect(
        ok({
          ...memory,
          kind: "memory.proposal.received",
          memory_object_id: object,
          actor_name: "Ann",
        }),
      ).toBe(true);
      expect(
        ok({
          ...memory,
          kind: "memory.suggestion.accepted",
          memory_object_id: object,
          project_id: project,
        }),
      ).toBe(true);
      expect(
        ok({ ...memory, kind: "memory.site_proposal.dismissed", memory_object_id: object }),
      ).toBe(true);
    });
    it("refuses what a memory kind does not name", () => {
      expect(ok({ ...memory, kind: "memory.scope.near_full" })).toBe(false);
      expect(ok({ ...memory, kind: "memory.scope.near_full", memory_scope: "user" })).toBe(false);
      expect(ok({ ...memory, kind: "memory.review.digest", item_count: 6 })).toBe(false);
      expect(
        ok({
          ...memory,
          kind: "memory.review.digest",
          related_kind: "memory.review.digest",
          item_count: 6,
        }),
      ).toBe(false);
      expect(ok({ ...memory, kind: "memory.review.reminder" })).toBe(false);
      expect(ok({ ...memory, kind: "memory.review.candidates_ready", item_count: 3 })).toBe(false);
      expect(
        ok({
          ...memory,
          kind: "memory.proposal.received",
          memory_object_id: object,
          thread_id: EXAMPLE_IDS.thread,
        }),
      ).toBe(false);
      expect(ok({ ...memory, kind: "memory.proposal.received" })).toBe(false);
      expect(ok({ ...memory, kind: "memory.suggestion.received", memory_object_id: object })).toBe(
        false,
      );
      expect(
        ok({
          ...memory,
          kind: "memory.proposal.received",
          memory_object_id: object,
          schedule_id: notification.schedule_id,
        }),
      ).toBe(false);
      // Older kinds carry no memory fields.
      expect(ok({ ...notification, memory_object_id: object })).toBe(false);
    });
  });
  it("parses a team notification: the Site admin, no schedule, thread, run or skill (KOBE-638)", () => {
    const added = {
      ...notification,
      kind: "team.member.added",
      schedule_id: null,
      thread_id: null,
      run_id: null,
      actor_name: "Ada Admin",
    };
    expect(notificationSchema.safeParse(added).success).toBe(true);
    expect(
      notificationSchema.safeParse({ ...added, schedule_id: notification.schedule_id }).success,
    ).toBe(false);
    expect(
      notificationSchema.safeParse({ ...added, skill_id: notification.schedule_id }).success,
    ).toBe(false);
    const told = {
      ...added,
      kind: "team.site_admin.member_role_changed",
      subject_name: "Bob",
      team_role: "contributor",
    };
    expect(notificationSchema.safeParse(told).success).toBe(true);
  });
  it("names the Site admin of a site-published version (KOBE-495)", () => {
    const published = {
      ...notification,
      kind: "skill.version.site_published",
      schedule_id: null,
      thread_id: null,
      run_id: null,
      skill_id: notification.schedule_id,
      skill_name: "sales-report",
      skill_semver: "1.3.0",
      actor_name: "Ada Admin",
    };
    expect(notificationSchema.safeParse(published).success).toBe(true);
    expect(notificationSchema.safeParse({ ...published, skill_semver: undefined }).success).toBe(
      false,
    );
  });
  it("parses a retirement notification: a skill and, for a version, its semver (KOBE-340)", () => {
    const revoked = {
      ...notification,
      kind: "skill.version.revoked",
      schedule_id: null,
      thread_id: null,
      run_id: null,
      skill_id: notification.schedule_id,
      skill_name: "sales-report",
      skill_semver: "1.2.0",
    };
    expect(notificationSchema.safeParse(revoked).success).toBe(true);
    expect(notificationSchema.safeParse({ ...revoked, skill_semver: undefined }).success).toBe(
      false,
    );
    const deprecated = { ...revoked, kind: "skill.deprecated", skill_semver: undefined };
    expect(notificationSchema.safeParse(deprecated).success).toBe(true);
    expect(notificationSchema.safeParse({ ...deprecated, skill_semver: "1.0.0" }).success).toBe(
      false,
    );
  });
  it("parses a skill notification: a skill, no schedule (KOBE-338)", () => {
    const blocked = {
      ...notification,
      kind: "skill.member_add.blocked",
      schedule_id: null,
      thread_id: null,
      run_id: null,
      skill_id: notification.schedule_id,
      skill_name: "sales-report",
    };
    expect(notificationSchema.safeParse(blocked).success).toBe(true);
    expect(notificationSchema.safeParse({ ...blocked, skill_id: undefined }).success).toBe(false);
    expect(
      notificationSchema.safeParse({ ...blocked, schedule_id: notification.schedule_id }).success,
    ).toBe(false);
    expect(notificationSchema.safeParse({ ...notification, schedule_id: null }).success).toBe(
      false,
    );
    expect(notificationSchema.safeParse({ ...notification, skill_name: "x" }).success).toBe(false);
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
