import { SCHEDULE_PAUSED_BY } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { pausedByLabel } from "./paused-by";

describe("pausedByLabel (KOBE-570)", () => {
  it("has one wording per reason", () => {
    expect(SCHEDULE_PAUSED_BY.map(pausedByLabel)).toEqual([
      "Paused by a team admin",
      "Paused: owner deactivated or removed",
      "Paused: agent unavailable",
    ]);
  });
});
