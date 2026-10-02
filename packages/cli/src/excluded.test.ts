import { INSTALL_WIDE_TABLES, isTeamTable } from "@kobe/db";
import { describe, expect, it } from "vitest";
import { EXCLUDED_TABLES, isExcluded } from "./excluded.js";

describe("tables excluded from backups", () => {
  it("are real install-wide tables (a rename must update this list)", () => {
    for (const name of Object.keys(EXCLUDED_TABLES)) {
      expect(INSTALL_WIDE_TABLES).toContain(name);
      expect(isTeamTable(name)).toBe(false);
    }
  });

  it("hold bearer tokens, one-time tokens, signing keys or counters only", () => {
    expect(Object.keys(EXCLUDED_TABLES).sort()).toEqual([
      "jwks",
      "rate_limits",
      "sessions",
      "verifications",
    ]);
    for (const reason of Object.values(EXCLUDED_TABLES)) expect(reason.length).toBeGreaterThan(10);
  });

  it("includes every other table by default, so new tables are backed up", () => {
    expect(isExcluded("sessions")).toBe(true);
    expect(isExcluded("team_members")).toBe(false);
    expect(isExcluded("a_table_added_later")).toBe(false);
  });
});
