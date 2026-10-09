import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_SCHEDULES_PER_USER,
  SCHEDULE_ERROR_CODES,
  SCHEDULE_ERROR_HTTP_STATUS,
  SCHEDULE_MIN_INTERVAL_MINUTES,
  SCHEDULE_PROMPT_MAX,
  createScheduleBodySchema,
  listSchedulesQuerySchema,
  listSchedulesResponseSchema,
  patchScheduleBodySchema,
  scheduleErrorSchema,
  scheduleRecurrenceSchema,
  scheduleResponseSchema,
  scheduleThreadMarkerSchema,
  scheduleTimezoneSchema,
} from "./index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

const ok = (v: unknown) => scheduleRecurrenceSchema.safeParse(v).success;

describe("constants", () => {
  it("pins the D32 cap and the limits", () => {
    expect(MAX_ACTIVE_SCHEDULES_PER_USER).toBe(10);
    expect(SCHEDULE_MIN_INTERVAL_MINUTES).toBe(15);
    expect(SCHEDULE_PROMPT_MAX).toBe(10_000);
  });
  it("maps every error code to an HTTP status", () => {
    expect(SCHEDULE_ERROR_CODES).toEqual([
      "schedule_cap_reached",
      "invalid_recurrence",
      "invalid_timezone",
      "agent_not_runnable",
    ]);
    expect(SCHEDULE_ERROR_HTTP_STATUS.schedule_cap_reached).toBe(409);
    expect(Object.keys(SCHEDULE_ERROR_HTTP_STATUS).sort()).toEqual(
      [...SCHEDULE_ERROR_CODES].sort(),
    );
  });
});

describe("recurrence", () => {
  it("accepts each form", () => {
    expect(ok({ kind: "daily", at: "09:30" })).toBe(true);
    expect(ok({ kind: "weekdays", at: "00:00" })).toBe(true);
    expect(ok({ kind: "weekly", days: ["mon", "fri"], at: "23:59" })).toBe(true);
    expect(ok({ kind: "cron", expr: "0 9 * * 1-5" })).toBe(true);
    expect(ok({ kind: "cron", expr: "*/15 * * * *" })).toBe(true);
    expect(ok({ kind: "cron", expr: "0,30 8-18/2 1,15 * 0" })).toBe(true);
    expect(ok({ kind: "cron", expr: "0 9 * * 7" })).toBe(true);
  });
  it("rejects bad times and weekly days", () => {
    expect(ok({ kind: "daily", at: "24:00" })).toBe(false);
    expect(ok({ kind: "daily", at: "9:30" })).toBe(false);
    expect(ok({ kind: "daily", at: "09:60" })).toBe(false);
    expect(ok({ kind: "weekly", days: [], at: "09:00" })).toBe(false);
    expect(ok({ kind: "weekly", days: ["mon", "mon"], at: "09:00" })).toBe(false);
    expect(ok({ kind: "weekly", days: ["monday"], at: "09:00" })).toBe(false);
    expect(ok({ kind: "daily", at: "09:00", extra: 1 })).toBe(false);
    expect(ok({ kind: "hourly", at: "09:00" })).toBe(false);
  });
  it("validates cron strictly", () => {
    for (const expr of [
      "",
      "0 9 * *",
      "0 9 * * * *",
      "60 9 * * *",
      "0 24 * * *",
      "0 9 0 * *",
      "0 9 32 * *",
      "0 9 * 13 *",
      "0 9 * * 8",
      "5-1 9 * * *",
      "*/0 9 * * *",
      "0 9 * * MON",
      "@daily",
      "0 9 ? * *",
      "0  9 * * *",
      " 0 9 * * *",
      "0 9 * * 1,",
      "0 9 L * *",
    ]) {
      expect(ok({ kind: "cron", expr }), expr).toBe(false);
    }
  });
  it("enforces the minimum interval", () => {
    expect(ok({ kind: "cron", expr: "* * * * *" })).toBe(false);
    expect(ok({ kind: "cron", expr: "*/5 * * * *" })).toBe(false);
    expect(ok({ kind: "cron", expr: "0,10 * * * *" })).toBe(false);
    expect(ok({ kind: "cron", expr: "55,5 * * * *" })).toBe(false);
    expect(ok({ kind: "cron", expr: "0 9,9 * * *" })).toBe(true);
    expect(ok({ kind: "cron", expr: "0,15,30,45 * * * *" })).toBe(true);
    expect(ok({ kind: "cron", expr: "50 23,0 * * *" })).toBe(true);
  });
});

describe("timezone", () => {
  it("accepts IANA names", () => {
    for (const tz of ["UTC", "Europe/Berlin", "America/Argentina/Buenos_Aires", "Asia/Kolkata"]) {
      expect(scheduleTimezoneSchema.safeParse(tz).success, tz).toBe(true);
    }
  });
  it("rejects offsets, unknown and junk names", () => {
    for (const tz of ["", "+01:00", "UTC+2", "Mars/Olympus", "Europe/Berlin ", "../etc"]) {
      expect(scheduleTimezoneSchema.safeParse(tz).success, tz).toBe(false);
    }
  });
});

const base = {
  agent_id: EXAMPLE_IDS.agent,
  prompt: "Summarize my tickets",
  recurrence: { kind: "weekly", days: ["mon"], at: "08:00" },
  tz: "Europe/Berlin",
} as const;

describe("bodies", () => {
  it("create defaults active and notify_email", () => {
    const parsed = createScheduleBodySchema.parse(base);
    expect(parsed.active).toBe(true);
    expect(parsed.notify_email).toBe(false);
  });
  it("create rejects empty/long prompts and unknown keys", () => {
    expect(createScheduleBodySchema.safeParse({ ...base, prompt: "" }).success).toBe(false);
    expect(createScheduleBodySchema.safeParse({ ...base, prompt: " " }).success).toBe(false);
    expect(
      createScheduleBodySchema.safeParse({ ...base, prompt: "x".repeat(SCHEDULE_PROMPT_MAX) })
        .success,
    ).toBe(true);
    expect(
      createScheduleBodySchema.safeParse({ ...base, prompt: "x".repeat(SCHEDULE_PROMPT_MAX + 1) })
        .success,
    ).toBe(false);
    expect(createScheduleBodySchema.safeParse({ ...base, paused_by: null }).success).toBe(false);
  });
  it("patch needs at least one field and has no defaults", () => {
    expect(patchScheduleBodySchema.safeParse({}).success).toBe(false);
    expect(patchScheduleBodySchema.parse({ active: false })).toEqual({ active: false });
    expect(patchScheduleBodySchema.safeParse({ tz: "Nope/Nope" }).success).toBe(false);
  });
  it("list query defaults to mine", () => {
    expect(listSchedulesQuerySchema.parse({})).toEqual({ scope: "mine" });
    expect(listSchedulesQuerySchema.parse({ scope: "team" })).toEqual({ scope: "team" });
    expect(listSchedulesQuerySchema.safeParse({ scope: "all" }).success).toBe(false);
  });
});

describe("responses", () => {
  const response = {
    schedule_id: EXAMPLE_IDS.agent,
    team_id: EXAMPLE_IDS.team,
    user_id: EXAMPLE_IDS.user,
    ...base,
    active: true,
    notify_email: false,
    next_due_at: "2026-10-12T06:00:00Z",
    last_run_id: null,
    paused_by: null,
    created_at: "2026-10-09T10:00:00Z",
    updated_at: "2026-10-09T10:00:00Z",
  };
  it("decodes a schedule and a list", () => {
    expect(scheduleResponseSchema.safeParse(response).success).toBe(true);
    const paused = { ...response, active: false, next_due_at: null, paused_by: "team_admin" };
    expect(scheduleResponseSchema.safeParse(paused).success).toBe(true);
    expect(scheduleResponseSchema.safeParse({ ...paused, paused_by: "owner" }).success).toBe(false);
    expect(
      listSchedulesResponseSchema.safeParse({ schedules: [response, paused], active_count: 1 })
        .success,
    ).toBe(true);
  });
});

describe("errors", () => {
  it("cap error reports how many are active", () => {
    const e = scheduleErrorSchema.parse({
      code: "schedule_cap_reached",
      message: "You have 10 active schedules (limit 10)",
      active_count: 10,
      limit: MAX_ACTIVE_SCHEDULES_PER_USER,
    });
    expect(e.active_count).toBe(10);
    expect(scheduleErrorSchema.safeParse({ code: "nope", message: "x" }).success).toBe(false);
    expect(scheduleErrorSchema.safeParse({ code: "invalid_timezone", message: "x" }).success).toBe(
      true,
    );
  });
});

describe("Scheduled folder marker", () => {
  it("is nullable and old thread shapes decode as null", () => {
    expect(scheduleThreadMarkerSchema.parse({})).toEqual({ schedule_id: null });
    expect(scheduleThreadMarkerSchema.parse({ schedule_id: null })).toEqual({ schedule_id: null });
    expect(scheduleThreadMarkerSchema.parse({ schedule_id: EXAMPLE_IDS.agent })).toEqual({
      schedule_id: EXAMPLE_IDS.agent,
    });
    expect(scheduleThreadMarkerSchema.safeParse({ schedule_id: "x" }).success).toBe(false);
  });
});
