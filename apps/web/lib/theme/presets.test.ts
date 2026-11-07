import { contrastRatio, PRESET_IDS, PRESET_LABELS } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import {
  FACE_VARIABLES,
  FONT_STACK_VALUES,
  LANE_1_VALUE,
  MONO_STACK_VALUES,
  LANE_TOKENS,
  PRESET_SCHEME_TOKENS,
  PRESETS,
  RADIUS_SCALES,
  RADIUS_TOKENS,
  SYSTEM_MONO_STACK,
  type PresetSchemeToken,
  type SchemeValues,
} from "./presets";
import { asHex, THEME_DARK, THEME_LIGHT } from "./theme-css-source.test-helpers";

/** KOBE-500 (TH9, ac-2): the presets, `default` = theme.css exactly, every one meets the floor. */
describe("presets", () => {
  it("are the protocol's seven ids with their display names", () => {
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
      "Catalyst",
    ]);
  });

  /** KOBE-550: the glow, the page ambient and the shadows are preset tokens (docs/theming.md §7). */
  it("each sets the glow colour, the page ambient and the three shadows", () => {
    for (const token of [
      "--kobe-glow-color",
      "--kobe-page-ambient",
      "--kobe-shadow-pop",
      "--kobe-shadow-drawer",
      "--kobe-shadow-panel",
    ]) {
      expect(PRESET_SCHEME_TOKENS).toContain(token);
    }
    for (const preset of Object.values(PRESETS)) {
      for (const values of [preset.light, preset.dark]) {
        expect(values["--kobe-glow-color"]).toMatch(/^(?:color-mix\(|rgb\()/);
        expect(values["--kobe-page-ambient"]).toMatch(/^(?:none|radial-gradient\()/);
      }
    }
  });

  it("every preset but catalyst glows in its own brand colour and keeps today's shadows", () => {
    for (const preset of Object.values(PRESETS)) {
      if (preset.id === "catalyst") continue;
      for (const values of [preset.light, preset.dark]) {
        expect(values["--kobe-glow-color"]).toBe(
          "color-mix(in oklab, var(--kobe-brand-primary) 28%, transparent)",
        );
        expect(values["--kobe-page-ambient"]).toBe("none");
        expect(values["--kobe-shadow-pop"]).toBe(THEME_LIGHT.get("--kobe-shadow-pop"));
        expect(values["--kobe-shadow-drawer"]).toBe(THEME_LIGHT.get("--kobe-shadow-drawer"));
        expect(values["--kobe-shadow-panel"]).toBe(THEME_LIGHT.get("--kobe-shadow-panel"));
      }
    }
  });

  /** KOBE-555 (ac-2, TH10 as amended): only Catalyst names the shipped faces, over system stacks. */
  it("catalyst starts its stacks with Outfit and JetBrains Mono; the others keep system stacks", () => {
    expect(PRESETS.catalyst.font).toBe("catalyst");
    expect(FONT_STACK_VALUES.catalyst).toBe(
      `var(${FACE_VARIABLES.outfit}, Outfit), ${FONT_STACK_VALUES.grotesk}`,
    );
    expect(MONO_STACK_VALUES.catalyst).toBe(
      `var(${FACE_VARIABLES.jetbrainsMono}, "JetBrains Mono"), ${THEME_LIGHT.get("--kobe-font-mono")}`,
    );
    const shipped = /var\(--kobe-face-|Outfit|JetBrains/;
    for (const preset of Object.values(PRESETS)) {
      if (preset.id === "catalyst") continue;
      expect(FONT_STACK_VALUES[preset.font], preset.id).not.toMatch(shipped);
      expect(MONO_STACK_VALUES[preset.font], preset.id).toBeUndefined();
    }
    expect(PRESETS.slate.font).toBe("grotesk");
    expect(PRESETS.ember.font).toBe("grotesk");
  });

  /** KOBE-550: Catalyst's own glow (its tokens' --glow-color), glow shadows and the dark ambient. */
  it("catalyst carries Catalyst's glow, glow shadows and the Rehoboam ambient", () => {
    const { light, dark } = PRESETS.catalyst;
    expect(PRESETS.catalyst.label).toBe("Catalyst");
    expect(PRESETS.catalyst.corners).toBe("soft");
    expect(light["--kobe-glow-color"]).toBe("rgb(25 118 210 / 30%)");
    expect(dark["--kobe-glow-color"]).toBe("rgb(79 195 247 / 25%)");
    expect(light["--kobe-page-ambient"]).toBe("none");
    expect(dark["--kobe-page-ambient"]).toMatch(/^radial-gradient\(/);
    for (const values of [light, dark]) {
      for (const shadow of [
        "--kobe-shadow-pop",
        "--kobe-shadow-drawer",
        "--kobe-shadow-panel",
      ] as const) {
        expect(values[shadow]).toMatch(/^0 0 \d+px var\(--kobe-glow-color\)$/);
      }
    }
    expect(dark["--kobe-brand-primary"]).toBe("#4fc3f7");
    expect(light["--kobe-brand-primary"]).toBe("#1565c0");
    expect(dark["--background"]).toBe("#06080e");
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
    expect(MONO_STACK_VALUES[preset.font]).toBeUndefined();
    expect(SYSTEM_MONO_STACK).toBe(THEME_LIGHT.get("--kobe-font-mono"));
    expect(Object.keys(MONO_STACK_VALUES)).toEqual(["catalyst"]);
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
    expect(FONT_STACK_VALUES.catalyst).toBe(
      'var(--kobe-face-outfit, Outfit), Inter, Roboto, "Helvetica Neue", "Arial Nova", "Nimbus Sans", Arial, sans-serif',
    );
    expect(MONO_STACK_VALUES.catalyst).toBe(
      'var(--kobe-face-jetbrains-mono, "JetBrains Mono"), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
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
  const hex = (token: string): string | null => {
    const value = (values as Record<string, string>)[token] ?? fixed.get(token) ?? "";
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    return ref ? hex(ref[1] as string) : asHex(value);
  };
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
  // 6. The Conversation tree's lane colours (CT7): lines and nodes, 3:1 on every page and panel.
  for (const lane of LANE_TOKENS) for (const bg of PAGES) need(lane, bg, 3);
  return failures;
}

describe("the contrast floor (docs/theming.md §8)", () => {
  it.each(PRESET_IDS)("%s meets it in light and dark", (id) => {
    const preset = PRESETS[id];
    expect(floorFailures(id, preset.light, THEME_LIGHT), "light").toEqual([]);
    expect(floorFailures(id, preset.dark, THEME_DARK), "dark").toEqual([]);
  });
});

/** KOBE-545 (CT7, ac-4): eight lane colours per preset and scheme, lane 1 the accent. */
describe("lane colours", () => {
  const resolved = (values: SchemeValues, token: PresetSchemeToken): string => {
    const value = values[token];
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    return ref ? resolved(values, ref[1] as PresetSchemeToken) : value;
  };

  it.each(PRESET_IDS)("%s defines --kobe-lane-1..8 in light and dark, lane 1 the link", (id) => {
    for (const values of [PRESETS[id].light, PRESETS[id].dark]) {
      expect(values["--kobe-lane-1"]).toBe(LANE_1_VALUE);
      const colours = LANE_TOKENS.map((t) => resolved(values, t));
      for (const c of colours) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      expect(new Set(colours).size, "eight distinct colours").toBe(8);
    }
  });

  it("lanes 2-8 are the preset's own, not one shared palette", () => {
    const palettes = PRESET_IDS.map((id) =>
      LANE_TOKENS.slice(1)
        .map((t) => PRESETS[id].light[t])
        .join(" "),
    );
    expect(new Set(palettes).size).toBe(PRESET_IDS.length);
  });
});
