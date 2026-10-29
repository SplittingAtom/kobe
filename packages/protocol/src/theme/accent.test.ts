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
  it("keeps the accent as the light primary, lightens the dark one, darkens each hover", () => {
    const d = deriveAccent("#2449c7");
    expect(d.primary.light).toBe("#2449c7");
    expect(relativeLuminance(d.primary.dark)).toBeGreaterThan(relativeLuminance("#2449c7"));
    for (const bg of [DEFAULT_SURFACES.dark.page, DEFAULT_SURFACES.dark.panel]) {
      expect(contrastRatio(d.primary.dark, bg)).toBeGreaterThanOrEqual(3);
    }
    for (const scheme of ["light", "dark"] as const) {
      expect(relativeLuminance(d.primaryHover[scheme])).toBeLessThan(
        relativeLuminance(d.primary[scheme]),
      );
    }
    expect(d.primaryFg.light).toBe("#ffffff");
    expect(deriveAccent("#ffd43b").primaryFg).toEqual({ light: "#111111", dark: "#111111" });
    // A fill already bright enough on dark stays as it is.
    expect(deriveAccent("#4263eb").primary.dark).toBe("#4263eb");
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

  it("passes good accents in both schemes", () => {
    expect(checkFloor(custom("#2449c7")).failures).toEqual([]);
    expect(checkFloor(custom("#2449c7")).ok).toBe(true);
    expect(checkFloor(custom("#15803d")).ok).toBe(true);
  });

  it("refuses a mid-grey accent with the rule and ratio", () => {
    const report = checkFloor(custom("#777777"));
    expect(report.ok).toBe(false);
    const fg = report.failures.find((f) => f.rule === "fg_on_primary" && f.scheme === "light");
    expect(fg).toMatchObject({ required: 4.5 });
    expect(fg?.ratio).toBeLessThan(4.5);
  });

  it("refuses an accent that does not stand out from the light page or panel", () => {
    for (const accent of ["#ffffff", "#f4f4f6"]) {
      const report = checkFloor(custom(accent));
      expect(report.ok, accent).toBe(false);
      expect(report.failures).toContainEqual(
        expect.objectContaining({ rule: "primary_on_surface", scheme: "light", required: 3 }),
      );
    }
    // A near-black accent lightens to a usable dark fill, and passes.
    expect(checkFloor(custom("#16161a")).failures.filter((f) => f.scheme === "dark")).toEqual([]);
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
