import { describe, expect, it } from "vitest";
import type { ScheduleRecurrence } from "@kobe/protocol";
import { nextOccurrence, recurrenceToCron } from "./recurrence.js";

const at = (iso: string) => new Date(iso);
const next = (r: ScheduleRecurrence, tz: string, after: string) =>
  nextOccurrence(r, tz, at(after))?.toISOString();

describe("recurrenceToCron", () => {
  it("maps the presets to cron", () => {
    expect(recurrenceToCron({ kind: "daily", at: "09:05" })).toBe("5 9 * * *");
    expect(recurrenceToCron({ kind: "weekdays", at: "18:00" })).toBe("0 18 * * 1-5");
    expect(recurrenceToCron({ kind: "weekly", days: ["sun", "mon", "wed"], at: "07:30" })).toBe(
      "30 7 * * 0,1,3",
    );
    expect(recurrenceToCron({ kind: "cron", expr: "*/30 8-17 * * 1-5" })).toBe("*/30 8-17 * * 1-5");
  });
});

describe("nextOccurrence", () => {
  it("daily: later today, else tomorrow, in the zone", () => {
    const r: ScheduleRecurrence = { kind: "daily", at: "09:00" };
    // 2026-01-15 is winter: Berlin = UTC+1, New York = UTC-5.
    expect(next(r, "Europe/Berlin", "2026-01-15T07:00:00Z")).toBe("2026-01-15T08:00:00.000Z");
    expect(next(r, "Europe/Berlin", "2026-01-15T08:00:00Z")).toBe("2026-01-16T08:00:00.000Z");
    expect(next(r, "America/New_York", "2026-01-15T07:00:00Z")).toBe("2026-01-15T14:00:00.000Z");
    expect(next(r, "UTC", "2026-01-15T09:00:00Z")).toBe("2026-01-16T09:00:00.000Z");
  });

  it("weekdays: skips the weekend", () => {
    const r: ScheduleRecurrence = { kind: "weekdays", at: "09:00" };
    // Friday 2026-01-16 after 09:00 UTC -> Monday 2026-01-19.
    expect(next(r, "UTC", "2026-01-16T10:00:00Z")).toBe("2026-01-19T09:00:00.000Z");
    expect(next(r, "UTC", "2026-01-17T00:00:00Z")).toBe("2026-01-19T09:00:00.000Z");
  });

  it("weekly: the named days only", () => {
    const r: ScheduleRecurrence = { kind: "weekly", days: ["tue", "sun"], at: "06:15" };
    expect(next(r, "UTC", "2026-01-12T00:00:00Z")).toBe("2026-01-13T06:15:00.000Z"); // Mon -> Tue
    expect(next(r, "UTC", "2026-01-13T06:15:00Z")).toBe("2026-01-18T06:15:00.000Z"); // Tue -> Sun
  });

  it("cron: lists, steps and a day of month", () => {
    expect(next({ kind: "cron", expr: "0,30 9 * * *" }, "UTC", "2026-01-15T09:00:00Z")).toBe(
      "2026-01-15T09:30:00.000Z",
    );
    expect(next({ kind: "cron", expr: "*/20 * * * *" }, "UTC", "2026-01-15T09:41:00Z")).toBe(
      "2026-01-15T10:00:00.000Z",
    );
    expect(next({ kind: "cron", expr: "0 12 1 * *" }, "UTC", "2026-01-15T00:00:00Z")).toBe(
      "2026-02-01T12:00:00.000Z",
    );
    // Day of week 7 is Sunday too.
    expect(next({ kind: "cron", expr: "0 8 * * 7" }, "UTC", "2026-01-12T00:00:00Z")).toBe(
      "2026-01-18T08:00:00.000Z",
    );
  });

  it("cron: day of month and day of week both set match either (Vixie rule)", () => {
    // 2026-01-14 is a Wednesday; the 15th is a Thursday. "0 0 15 * 1" -> next is Monday the 19th? No: the 15th comes first.
    expect(next({ kind: "cron", expr: "0 0 15 * 1" }, "UTC", "2026-01-14T00:00:00Z")).toBe(
      "2026-01-15T00:00:00.000Z",
    );
    expect(next({ kind: "cron", expr: "0 0 15 * 1" }, "UTC", "2026-01-15T00:00:00Z")).toBe(
      "2026-01-19T00:00:00.000Z",
    );
  });

  it("cron: a rare date (Feb 29) is found years ahead", () => {
    expect(next({ kind: "cron", expr: "0 0 29 2 *" }, "UTC", "2026-03-01T00:00:00Z")).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  describe("DST", () => {
    it("spring-forward gap: a nonexistent local time fires at the next valid instant", () => {
      // Berlin 2026-03-29: 02:00 -> 03:00 (UTC+1 -> UTC+2). 02:30 does not exist; valid again at 01:00Z.
      const r: ScheduleRecurrence = { kind: "daily", at: "02:30" };
      expect(next(r, "Europe/Berlin", "2026-03-27T12:00:00Z")).toBe("2026-03-28T01:30:00.000Z");
      expect(next(r, "Europe/Berlin", "2026-03-28T23:00:00Z")).toBe("2026-03-29T01:00:00.000Z");
      // The day after is normal again (02:30 CEST = 00:30Z).
      expect(next(r, "Europe/Berlin", "2026-03-29T01:00:00Z")).toBe("2026-03-30T00:30:00.000Z");
    });

    it("spring-forward gap in New York (02:30 on 2026-03-08)", () => {
      const r: ScheduleRecurrence = { kind: "daily", at: "02:30" };
      // 02:00 EST -> 03:00 EDT happens at 07:00Z.
      expect(next(r, "America/New_York", "2026-03-08T00:00:00Z")).toBe("2026-03-08T07:00:00.000Z");
    });

    it("two cron times in the gap fire once", () => {
      const r: ScheduleRecurrence = { kind: "cron", expr: "15,45 2 * * *" };
      const first = nextOccurrence(r, "Europe/Berlin", at("2026-03-28T23:00:00Z"));
      expect(first?.toISOString()).toBe("2026-03-29T01:00:00.000Z");
      const second = nextOccurrence(r, "Europe/Berlin", first as Date);
      expect(second?.toISOString()).toBe("2026-03-30T00:15:00.000Z");
    });

    it("fall-back overlap: a repeated local time fires once, at its first occurrence", () => {
      // Berlin 2026-10-25: 03:00 CEST -> 02:00 CET. 02:30 occurs at 00:30Z (CEST) and 01:30Z (CET).
      const r: ScheduleRecurrence = { kind: "daily", at: "02:30" };
      const first = nextOccurrence(r, "Europe/Berlin", at("2026-10-24T12:00:00Z"));
      expect(first?.toISOString()).toBe("2026-10-25T00:30:00.000Z");
      const after = nextOccurrence(r, "Europe/Berlin", first as Date);
      expect(after?.toISOString()).toBe("2026-10-26T01:30:00.000Z");
    });

    it("a time outside the transition is unaffected (09:00 stays 09:00 local)", () => {
      const r: ScheduleRecurrence = { kind: "daily", at: "09:00" };
      expect(next(r, "Europe/Berlin", "2026-03-28T12:00:00Z")).toBe("2026-03-29T07:00:00.000Z");
      expect(next(r, "Europe/Berlin", "2026-10-24T12:00:00Z")).toBe("2026-10-25T08:00:00.000Z");
    });

    it("a half-hour DST zone (Lord Howe) is handled", () => {
      const r: ScheduleRecurrence = { kind: "daily", at: "12:00" };
      // Lord Howe is UTC+10:30 in winter (June).
      expect(next(r, "Australia/Lord_Howe", "2026-06-10T00:00:00Z")).toBe("2026-06-10T01:30:00.000Z");
    });
  });

  it("a timezone change recomputes the next occurrence", () => {
    const r: ScheduleRecurrence = { kind: "daily", at: "09:00" };
    const after = "2026-01-15T00:00:00Z";
    expect(next(r, "Europe/Berlin", after)).toBe("2026-01-15T08:00:00.000Z");
    expect(next(r, "Asia/Tokyo", after)).toBe("2026-01-16T00:00:00.000Z");
    expect(next(r, "Asia/Tokyo", "2026-01-14T23:00:00Z")).toBe("2026-01-15T00:00:00.000Z");
  });
});
