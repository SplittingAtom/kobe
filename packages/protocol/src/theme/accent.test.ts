import { describe, expect, it } from "vitest";
import type { ThemeSettings } from "../branding.js";
import { DEFAULT_SURFACES, checkFloor, deriveAccent } from "./accent.js";
import { contrastRatio, relativeLuminance } from "./colour.js";

const custom = (accent: string): ThemeSettings => ({
  preset: "custom",
  accent,
  corners: "soft",
  font: "system",
});

describe("deriveAccent", () => {
  it("keeps the accent as primary and darkens the hover", () => {
    const d = deriveAccent("#2449c7");
    expect(d.primary).toBe("#2449c7");
    expect(relativeLuminance(d.primaryHover)).toBeLessThan(relativeLuminance(d.primary));
    expect(d.primaryFg).toBe("#ffffff");
    expect(deriveAccent("#ffd43b").primaryFg).toBe("#111111");
  });

  it("derives links that reach 4.5:1 on page and panel in each scheme", () => {
    for (const accent of ["#2449c7", "#15803d", "#e8590c", "#ffd43b"]) {
      const d = deriveAccent(accent);
      const { light, dark } = DEFAULT_SURFACES;
      for (const bg of [light.page, light.panel]) {
        expect(contrastRatio(d.link.light, bg)).toBeGreaterThanOrEqual(4.5);
      }
      for (const bg of [dark.page, dark.panel]) {
        expect(contrastRatio(d.link.dark, bg)).toBeGreaterThanOrEqual(4.5);
      }
      expect(d.link.light).not.toBe(d.link.dark);
    }
  });

  it("uses the link as focus when it already reaches 3:1", () => {
    const d = deriveAccent("#2449c7");
    expect(d.focus).toEqual(d.link);
  });
});

describe("checkFloor", () => {
  it("passes presets", () => {
    expect(checkFloor({ preset: "forest" })).toMatchObject({ ok: true, failures: [] });
  });

  it("passes good accents", () => {
    expect(checkFloor(custom("#2449c7")).ok).toBe(true);
    expect(checkFloor(custom("#15803d")).ok).toBe(true);
  });

  it("refuses a mid-grey accent with the rule and ratio", () => {
    const report = checkFloor(custom("#777777"));
    expect(report.ok).toBe(false);
    expect(report.failures[0]).toMatchObject({
      rule: "primary-fg on primary",
      scheme: "both",
      required: 4.5,
    });
    expect(report.failures[0]?.ratio).toBeLessThan(4.5);
  });

  it("measures against the surfaces given", () => {
    const grey = { page: "#777777", panel: "#777777", card: "#777777" };
    const report = checkFloor(custom("#2449c7"), { light: grey, dark: grey });
    expect(report.ok).toBe(false);
    // Lightening toward white cannot reach 4.5:1 on #777777 (white is 4.48:1).
    expect(report.failures).toContainEqual(
      expect.objectContaining({ rule: "link on page", scheme: "dark", required: 4.5 }),
    );
  });
});
