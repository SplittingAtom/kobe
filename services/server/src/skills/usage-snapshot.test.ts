import { describe, expect, it } from "vitest";
import { msToNextNightly, usageWindow, utcDay } from "./usage-snapshot.js";

/** KOBE-339: the fixed window and the nightly refresh. */
describe("the usage window", () => {
  it("is the last 30 finished UTC days, ending at the start of today", () => {
    const now = new Date("2026-10-19T15:30:00.000Z");
    expect(usageWindow(utcDay(now))).toEqual({
      from: "2026-09-19T00:00:00.000Z",
      to: "2026-10-19T00:00:00.000Z",
    });
  });

  it("refreshes at 00:05 UTC", () => {
    expect(msToNextNightly(new Date("2026-10-19T00:00:00.000Z"))).toBe(5 * 60_000);
    expect(msToNextNightly(new Date("2026-10-19T00:05:00.000Z"))).toBe(86_400_000);
    expect(msToNextNightly(new Date("2026-10-19T23:00:00.000Z"))).toBe(65 * 60_000);
  });
});
