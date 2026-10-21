import { describe, expect, it } from "vitest";
import { REPAIR_USAGE, parseRepairArgs } from "./workspace-repair-args.js";

const TEAM = "6d6e5723-7d71-4705-b614-79f5cc87fe64";
const USER = "8d4c24f0-cfb7-43f7-a090-95f1c3d94467";

describe("workspace-repair arguments (KOBE-475)", () => {
  it("parses the options", () => {
    expect(parseRepairArgs([])).toEqual({ dryRun: false });
    expect(
      parseRepairArgs([
        "--dry-run",
        "--team-id",
        TEAM,
        "--user-id",
        USER,
        "--max",
        "10",
        "--pace-ms",
        "0",
      ]),
    ).toEqual({ dryRun: true, teamId: TEAM, userId: USER, maxWorkspaces: 10, paceMs: 0 });
  });

  it("refuses bad ids, a user without a team, bad numbers and unknown flags", () => {
    for (const argv of [
      ["--team-id", "nope"],
      ["--user-id", USER],
      ["--max", "0"],
      ["--max", "-1"],
      ["--max", "1.5"],
      ["--max", "ten"],
      ["--pace-ms", "60001"],
      ["--pace-ms", ""],
      ["--force"],
      ["--max"],
    ]) {
      expect(parseRepairArgs(argv), argv.join(" ")).toBe(REPAIR_USAGE);
    }
  });
});
