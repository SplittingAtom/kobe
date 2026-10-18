import { describe, expect, it } from "vitest";
import {
  CHANGELOG_MAX,
  compareSemver,
  legacySemver,
  nextSemver,
  parseSemver,
  semverSchema,
  changelogSchema,
} from "./semver.js";

describe("skill semver (KOBE-308, SK14)", () => {
  it("parses MAJOR.MINOR.PATCH only", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseSemver("999999999.0.1")).toEqual({ major: 999999999, minor: 0, patch: 1 });
    for (const bad of [
      "1.2",
      "1.2.3.4",
      "v1.2.3",
      "01.2.3",
      "1.02.3",
      "1.2.3-beta",
      "1.2.3+b",
      "",
      " 1.2.3",
      "1000000000.0.0",
    ])
      expect(parseSemver(bad)).toBeNull();
  });

  it("compares numerically, not as text", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  it("reads legacy integer versions as 0.<n>.0", () => {
    expect(legacySemver(1)).toBe("0.1.0");
    expect(legacySemver(42)).toBe("0.42.0");
  });

  it("defaults the next version to a minor bump, or 0.1.0 for a new skill", () => {
    expect(nextSemver(null, undefined)).toEqual({ ok: true, semver: "0.1.0" });
    expect(nextSemver("0.3.0", undefined)).toEqual({ ok: true, semver: "0.4.0" });
    expect(nextSemver("1.4.2", undefined)).toEqual({ ok: true, semver: "1.5.0" });
    expect(nextSemver("1.999999998.3", undefined)).toEqual({ ok: true, semver: "1.999999999.0" });
    // The next minor would need ten digits: the uploader must give a number (e.g. 2.0.0).
    expect(nextSemver("1.999999999.0", undefined)).toEqual({
      ok: false,
      reason: "no_default",
      latest: "1.999999999.0",
    });
    expect(nextSemver("1.999999999.0", "2.0.0")).toEqual({ ok: true, semver: "2.0.0" });
  });

  it("takes a requested version only when it is above the latest", () => {
    expect(nextSemver(null, "1.0.0")).toEqual({ ok: true, semver: "1.0.0" });
    expect(nextSemver("0.3.0", "0.3.1")).toEqual({ ok: true, semver: "0.3.1" });
    expect(nextSemver("0.3.0", "0.3.0")).toEqual({
      ok: false,
      reason: "not_increasing",
      latest: "0.3.0",
    });
    expect(nextSemver("0.10.0", "0.9.0")).toEqual({
      ok: false,
      reason: "not_increasing",
      latest: "0.10.0",
    });
  });

  it("validates request values", () => {
    expect(semverSchema.safeParse("1.0.0").success).toBe(true);
    expect(semverSchema.safeParse("1.0").success).toBe(false);
    expect(changelogSchema.safeParse("Adds a totals row.").success).toBe(true);
    expect(changelogSchema.safeParse("").success).toBe(false);
    expect(changelogSchema.safeParse("x".repeat(CHANGELOG_MAX + 1)).success).toBe(false);
  });
});
