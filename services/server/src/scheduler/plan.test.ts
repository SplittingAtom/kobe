import { describe, expect, it } from "vitest";
import type { ScheduleRecurrence } from "@kobe/protocol";
import { planFire } from "./plan.js";

const MIN = 60_000;
const at = (s: string) => new Date(s);
const daily: ScheduleRecurrence = { kind: "daily", at: "09:00" };
const quarter: ScheduleRecurrence = { kind: "cron", expr: "*/15 * * * *" };
const GRACE = 60 * MIN;

const plan = (
  recurrence: ScheduleRecurrence,
  dueAt: string,
  now: string,
  tz = "UTC",
  graceMs = GRACE,
) => planFire({ recurrence, tz, dueAt: at(dueAt), now: at(now), graceMs });

describe("planFire", () => {
  it("fires the due occurrence on time and continues with the next one", () => {
    const p = plan(daily, "2026-10-10T09:00:00Z", "2026-10-10T09:00:20Z");
    expect(p.fireAt).toEqual(at("2026-10-10T09:00:00Z"));
    expect(p.next).toEqual(at("2026-10-11T09:00:00Z"));
    expect(p.skippedBefore).toBe(false);
  });

  it("fires a late occurrence once when it is within the grace window", () => {
    const p = plan(daily, "2026-10-10T09:00:00Z", "2026-10-10T09:40:00Z");
    expect(p.fireAt).toEqual(at("2026-10-10T09:00:00Z"));
    expect(p.skippedBefore).toBe(false);
  });

  it("skips an occurrence older than the grace window and says so", () => {
    const p = plan(daily, "2026-10-10T09:00:00Z", "2026-10-10T12:00:00Z");
    expect(p.fireAt).toBeNull();
    expect(p.skippedBefore).toBe(true);
    expect(p.next).toEqual(at("2026-10-11T09:00:00Z"));
  });

  it("collapses a burst of missed occurrences to the latest one inside the window", () => {
    // Down for 5 hours with a 15-minute schedule: only the latest occurrence fires.
    const p = plan(quarter, "2026-10-10T08:00:00Z", "2026-10-10T13:07:00Z");
    expect(p.fireAt).toEqual(at("2026-10-10T13:00:00Z"));
    expect(p.skippedBefore).toBe(true);
    expect(p.next).toEqual(at("2026-10-10T13:15:00Z"));
  });

  it("collapses missed occurrences inside the window to the latest as well", () => {
    const p = plan(quarter, "2026-10-10T12:15:00Z", "2026-10-10T12:50:00Z");
    expect(p.fireAt).toEqual(at("2026-10-10T12:45:00Z"));
    expect(p.skippedBefore).toBe(true);
  });

  it("uses the schedule's time zone", () => {
    const p = plan(daily, "2026-10-10T07:00:00Z", "2026-10-10T07:01:00Z", "Europe/Berlin");
    expect(p.next).toEqual(at("2026-10-11T07:00:00Z"));
  });

  it("returns no next occurrence for a recurrence that never fires again", () => {
    const never: ScheduleRecurrence = { kind: "cron", expr: "0 0 31 2 *" };
    expect(plan(never, "2026-10-10T09:00:00Z", "2026-10-10T09:00:00Z").next).toBeNull();
  });
});
