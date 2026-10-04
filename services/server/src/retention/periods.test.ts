import { describe, expect, it } from "vitest";
import {
  FOREVER_LAYER,
  allowedPeriods,
  changeLayer,
  effectiveAt,
  upcomingShortening,
  type RetentionPeriod,
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
    const now = new Date("2026-10-04T00:00:00Z");
    const layer = (applied: RetentionPeriod) => ({ ...FOREVER_LAYER, applied });
    expect(retentionView(layer("forever"), layer("1y"), now)).toEqual({
      period: "forever",
      maximum: "1y",
      effective: "1y",
      pending: null,
      upcoming: null,
    });
    expect(retentionView(layer("30d"), layer("1y"), now).effective).toBe("30d");
  });

  it("schedules a shortening 7 days out and applies a lengthening at once (user decision)", () => {
    const now = new Date("2026-10-04T00:00:00Z");
    const later = new Date("2026-10-11T00:00:00Z");
    const shorter = changeLayer(FOREVER_LAYER, "90d", now);
    expect(shorter).toEqual({
      kind: "scheduled",
      layer: { applied: "forever", pending: "90d", pendingAt: later },
    });
    // Until then the old period applies; from then on the new one (read-time settle).
    expect(effectiveAt(shorter.layer, FOREVER_LAYER, new Date(later.getTime() - 1))).toBe(
      "forever",
    );
    expect(effectiveAt(shorter.layer, FOREVER_LAYER, later)).toBe("90d");
    expect(upcomingShortening(shorter.layer, FOREVER_LAYER, now)).toEqual({
      period: "90d",
      effectiveAt: later,
    });
    // Lengthening (or going back) applies at once and drops the pending shortening.
    expect(changeLayer(shorter.layer, "forever", now)).toEqual({
      kind: "immediate",
      layer: FOREVER_LAYER,
    });
    expect(changeLayer(shorter.layer, "90d", now).kind).toBe("unchanged");
    const longer = changeLayer({ ...FOREVER_LAYER, applied: "30d" }, "1y", now);
    expect(longer).toEqual({ kind: "immediate", layer: { ...FOREVER_LAYER, applied: "1y" } });
  });

  it("announces only changes that shorten what applies", () => {
    const now = new Date("2026-10-04T00:00:00Z");
    const at = new Date("2026-10-11T00:00:00Z");
    const max90 = { ...FOREVER_LAYER, applied: "90d" as const };
    // The team lowers forever → 1y while the maximum is 90 days: nothing changes for the data.
    const team = { applied: "forever" as const, pending: "1y" as const, pendingAt: at };
    expect(upcomingShortening(team, max90, now)).toBeNull();
    // The maximum is lowered to 30 days: that one shortens.
    const max = { applied: "90d" as const, pending: "30d" as const, pendingAt: at };
    expect(upcomingShortening(FOREVER_LAYER, max, now)).toEqual({ period: "30d", effectiveAt: at });
  });

  it("keeps data when a stored value is unknown", () => {
    expect(parsePeriod("7d")).toBe("forever");
    expect(parsePeriod(undefined)).toBe("forever");
    expect(parsePeriod("90d")).toBe("90d");
  });
});
