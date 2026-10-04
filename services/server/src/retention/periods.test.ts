import { describe, expect, it } from "vitest";
import {
  allowedPeriods,
  parsePeriod,
  retentionView,
  shorterPeriod,
  withinMaximum,
} from "./periods.js";

describe("retention periods (D18)", () => {
  it("orders 30d < 90d < 1y < forever", () => {
    expect(shorterPeriod("forever", "1y")).toBe("1y");
    expect(shorterPeriod("30d", "90d")).toBe("30d");
    expect(shorterPeriod("forever", "forever")).toBe("forever");
  });

  it("lets a team choose only periods within the install maximum", () => {
    expect(allowedPeriods("forever")).toEqual(["30d", "90d", "1y", "forever"]);
    expect(allowedPeriods("90d")).toEqual(["30d", "90d"]);
    expect(withinMaximum("1y", "90d")).toBe(false);
    expect(withinMaximum("30d", "30d")).toBe(true);
  });

  it("applies the shorter of the team's period and the maximum", () => {
    expect(retentionView("forever", "1y")).toEqual({
      period: "forever",
      maximum: "1y",
      effective: "1y",
    });
    expect(retentionView("30d", "1y").effective).toBe("30d");
  });

  it("keeps data when a stored value is unknown", () => {
    expect(parsePeriod("7d")).toBe("forever");
    expect(parsePeriod(undefined)).toBe("forever");
    expect(parsePeriod("90d")).toBe("90d");
  });
});
