import { contrastRatio, PRESET_IDS, PRESET_LABELS } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import {
  FONT_STACK_VALUES,
  PRESET_SCHEME_TOKENS,
  PRESETS,
  RADIUS_SCALES,
  RADIUS_TOKENS,
  type PresetSchemeToken,
  type SchemeValues,
} from "./presets";
import { asHex, THEME_DARK, THEME_LIGHT } from "./theme-css-source.test-helpers";

/** KOBE-500 (TH9, ac-2): six presets, `default` = theme.css exactly, every one meets the floor. */
describe("presets", () => {
  it("are the protocol's six ids with their display names", () => {
    expect(Object.keys(PRESETS)).toEqual([...PRESET_IDS]);
    for (const id of PRESET_IDS) {
      expect(PRESETS[id].id).toBe(id);
      expect(PRESETS[id].label).toBe(PRESET_LABELS[id]);
    }
    expect(PRESET_IDS.map((id) => PRESETS[id].label)).toEqual([
      "Default",
      "Slate",
      "Forest",
      "Plum",
      "Ember",
      "Tokyo Nights",
    ]);
  });

  it("each sets every preset token in both schemes, with CSS-safe values only", () => {
    for (const preset of Object.values(PRESETS)) {
      for (const values of [preset.light, preset.dark]) {
        expect(Object.keys(values).sort()).toEqual([...PRESET_SCHEME_TOKENS].sort());
        for (const value of Object.values(values)) expect(value).toMatch(/^[\w\s#.,%/()-]+$/);
      }
    }
  });

  it("default reproduces app/theme.css byte for byte", () => {
    const preset = PRESETS.default;
    for (const token of PRESET_SCHEME_TOKENS) {
      expect(preset.light[token], `light ${token}`).toBe(THEME_LIGHT.get(token));
      expect(preset.dark[token], `dark ${token}`).toBe(THEME_DARK.get(token));
    }
    expect(FONT_STACK_VALUES[preset.font]).toBe(THEME_LIGHT.get("--kobe-font-sans"));
    for (const token of RADIUS_TOKENS) {
      expect(RADIUS_SCALES[preset.corners][token], token).toBe(THEME_LIGHT.get(token));
    }
  });

  it("font stacks and radius scales are the catalogue's (docs/theming.md §5, §6)", () => {
    expect(FONT_STACK_VALUES.system).toBe(
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
    );
    expect(FONT_STACK_VALUES.humanist).toBe(
      'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
    );
    expect(FONT_STACK_VALUES.grotesk).toBe(
      'Inter, Roboto, "Helvetica Neue", "Arial Nova", "Nimbus Sans", Arial, sans-serif',
    );
    expect(FONT_STACK_VALUES.serif).toBe(
      'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
    );
    expect(Object.values(RADIUS_SCALES.sharp)).toEqual(["0", "0", "0", "0", "0"]);
    expect(Object.values(RADIUS_SCALES.round)).toEqual([
      "0.5rem",
      "0.75rem",
      "1rem",
      "1.25rem",
      "9999px",
    ]);
  });
});

/** The fixed colours (§4.4) a preset's surfaces must keep readable (rule 5). */
const FIXED_TEXT = [
  "--kobe-status-running",
  "--kobe-status-attention",
  "--kobe-status-failed",
  "--kobe-status-done",
  "--kobe-status-idle",
  "--admin-danger",
  "--kobe-tool-badge",
] as const;

const PAGES = [
  "--background",
  "--card",
  "--popover",
  "--muted",
  "--kobe-console-bg",
  "--kobe-console-panel",
] as const satisfies readonly PresetSchemeToken[];

/** Contrast failures of one scheme against docs/theming.md §8 (rules 1-5). */
function floorFailures(id: string, values: SchemeValues, fixed: ReadonlyMap<string, string>) {
  const failures: string[] = [];
  const hex = (token: string): string | null =>
    asHex((values as Record<string, string>)[token] ?? fixed.get(token) ?? "");
  const need = (fg: string, bg: string, min: number) => {
    const a = hex(fg);
    const b = hex(bg);
    if (a === null || b === null)
      throw new Error(`${id}: ${fg} or ${bg} is not a measurable colour`);
    const ratio = contrastRatio(a, b);
    if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
  };
  // 1. Body and muted text on page, panel and card.
  for (const bg of PAGES) need("--foreground", bg, 4.5);
  for (const bg of ["--background", "--card", "--popover"]) need("--muted-foreground", bg, 4.5);
  for (const bg of ["--kobe-console-bg", "--kobe-console-panel"]) {
    need("--kobe-console-fg", bg, 4.5);
    need("--kobe-console-muted", bg, 4.5);
  }
  need("--primary-foreground", "--primary", 4.5);
  need("--secondary-foreground", "--secondary", 4.5);
  need("--accent-foreground", "--accent", 4.5);
  // 2. Links on page and panel.
  for (const bg of PAGES) need("--kobe-brand-link", bg, 4.5);
  // 3. Text on the primary fill and its hover (default's hover is a color-mix over the fill,
  //    measured by app/theme-css.test.ts).
  need("--kobe-brand-primary-fg", "--kobe-brand-primary", 4.5);
  if (hex("--kobe-brand-primary-hover") !== null) {
    need("--kobe-brand-primary-fg", "--kobe-brand-primary-hover", 4.5);
  }
  // 4. Focus outlines and control borders: 3:1 (WCAG 1.4.11). Default's chat ring stays today's
  //    neutral grey (docs/theming.md §4.2), so only the themed presets are held to it.
  const outlines = [
    "--kobe-brand-focus",
    "--kobe-composer-focus",
    ...(id === "default" ? [] : ["--ring"]),
  ];
  for (const outline of outlines) for (const bg of PAGES) need(outline, bg, 3);
  for (const bg of ["--kobe-console-bg", "--kobe-console-panel"]) {
    need("--kobe-console-control-border", bg, 3);
  }
  // 5. The fixed status, danger and tool colours on the retinted surfaces.
  for (const fg of FIXED_TEXT) for (const bg of PAGES) need(fg, bg, 4.5);
  return failures;
}

describe("the contrast floor (docs/theming.md §8)", () => {
  it.each(PRESET_IDS)("%s meets it in light and dark", (id) => {
    const preset = PRESETS[id];
    expect(floorFailures(id, preset.light, THEME_LIGHT), "light").toEqual([]);
    expect(floorFailures(id, preset.dark, THEME_DARK), "dark").toEqual([]);
  });
});
