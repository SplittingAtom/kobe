import { deriveAccent, PRESET_IDS, type ThemeSettings } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { BRANDING_CSS_ALLOWED, brandingCss } from "./branding-css";
import { PRESET_SCHEME_TOKENS, PRESETS } from "./presets";
import { block, declarations } from "./theme-css-source.test-helpers";

/** KOBE-500 (TH5, ac-2): the theme <style> is token declarations in theme.css's three blocks. */
const CUSTOM: ThemeSettings = { preset: "custom", accent: "#0f766e", corners: "round", font: "serif" };
const THEMES: ThemeSettings[] = [
  ...PRESET_IDS.filter((id) => id !== "default").map((preset) => ({ preset })),
  CUSTOM,
  { preset: "custom", accent: "#ffd400", corners: "sharp", font: "system" },
];

function blocks(css: string, scope = ":root") {
  return {
    light: declarations(block(css, scope)),
    chosenDark: declarations(block(css, `${scope}[data-theme="dark"]`)),
    osDark: declarations(
      block(block(css, "@media (prefers-color-scheme: dark)"), `${scope}:not([data-theme="light"])`),
    ),
  };
}

const ALLOWED_NAME = /^--(?:kobe-brand-[\w-]+|kobe-radius-[\w-]+|kobe-font-sans|ring|kobe-composer-focus)$/;
const PRESET_NAMES = new Set<string>(PRESET_SCHEME_TOKENS);

describe("brandingCss", () => {
  it("is empty for the default preset: theme.css already is it", () => {
    expect(brandingCss({ preset: "default" })).toBe("");
    expect(brandingCss({ preset: "default" }, "#preview")).toBe("");
  });

  it.each(THEMES)("has the three blocks, the two dark ones equal (%o)", (theme) => {
    const css = brandingCss(theme);
    const { light, chosenDark, osDark } = blocks(css);
    expect(light.length).toBeGreaterThan(0);
    expect(chosenDark.length).toBeGreaterThan(0);
    expect(osDark).toEqual(chosenDark);
    // Nothing but the three blocks.
    expect(css.match(/\{/g)).toHaveLength(4);
  });

  it.each(THEMES)("declares only theme tokens, in the allowed characters (%o)", (theme) => {
    const css = brandingCss(theme);
    expect(css).toMatch(BRANDING_CSS_ALLOWED);
    expect(BRANDING_CSS_ALLOWED.test(css)).toBe(true);
    const { light, chosenDark } = blocks(css);
    for (const [name] of [...light, ...chosenDark]) {
      const ok = ALLOWED_NAME.test(name) || (theme.preset !== "custom" && PRESET_NAMES.has(name));
      expect(ok, name).toBe(true);
    }
    expect(css).not.toMatch(/url\(|@import|expression|\\/i);
  });

  it("the allow-list is the plan's and rejects what could escape a declaration", () => {
    expect(BRANDING_CSS_ALLOWED.source).toBe(String.raw`^[\s\w:;{}()#.,%/@"=[\]-]*$`);
    for (const bad of ["a<b", "x'y", "\\61", "a!important", "*{}", "a>b", "a&b"]) {
      expect(BRANDING_CSS_ALLOWED.test(bad), bad).toBe(false);
    }
  });

  it("scopes every block to the preview root", () => {
    const css = brandingCss({ preset: "forest" }, "#preview-light");
    const { light, chosenDark, osDark } = blocks(css, "#preview-light");
    expect(new Map(light).get("--kobe-brand-primary")).toBe(PRESETS.forest.light["--kobe-brand-primary"]);
    expect(new Map(chosenDark).get("--kobe-brand-primary")).toBe(PRESETS.forest.dark["--kobe-brand-primary"]);
    expect(osDark).toEqual(chosenDark);
    expect(css).not.toContain(":root");
  });

  it("refuses a scope that is not :root or an id", () => {
    for (const scope of ["body", "#a{}", ":root, html", "#1x", ""]) {
      expect(() => brandingCss({ preset: "slate" }, scope), scope).toThrow(/scope/);
    }
  });

  it("a preset sets its light and dark values, corners and typeface", () => {
    const { light, chosenDark } = blocks(brandingCss({ preset: "ember" }));
    const l = new Map(light);
    const d = new Map(chosenDark);
    for (const token of PRESET_SCHEME_TOKENS) {
      expect(l.get(token), token).toBe(PRESETS.ember.light[token]);
      expect(d.get(token), token).toBe(PRESETS.ember.dark[token]);
    }
    expect(l.get("--kobe-radius-md")).toBe("0");
    expect(l.get("--kobe-font-sans")).toMatch(/^Inter, /);
    expect(d.has("--kobe-radius-md")).toBe(false);
  });

  it("a custom accent emits the derived values over the default neutrals", () => {
    const derived = deriveAccent("#0f766e");
    const { light, chosenDark } = blocks(brandingCss(CUSTOM));
    const l = new Map(light);
    const d = new Map(chosenDark);
    for (const m of [l, d]) {
      expect(m.get("--kobe-brand-primary")).toBe(derived.primary);
      expect(m.get("--kobe-brand-primary-hover")).toBe(derived.primaryHover);
      expect(m.get("--kobe-brand-primary-fg")).toBe(derived.primaryFg);
      expect(m.get("--ring")).toBe("var(--kobe-brand-focus)");
      expect(m.get("--kobe-composer-focus")).toBe("var(--kobe-brand-focus)");
      expect(m.has("--background")).toBe(false);
      expect(m.has("--kobe-console-bg")).toBe(false);
    }
    expect(l.get("--kobe-brand-link")).toBe(derived.link.light);
    expect(d.get("--kobe-brand-link")).toBe(derived.link.dark);
    expect(l.get("--kobe-brand-focus")).toBe(derived.focus.light);
    expect(d.get("--kobe-brand-focus")).toBe(derived.focus.dark);
    expect(l.get("--kobe-radius-lg")).toBe("1rem");
    expect(l.get("--kobe-font-sans")).toMatch(/^Charter, /);
  });

  it("emits nothing for a value that slipped past validation", () => {
    const bad = { preset: "custom", accent: "red;}*{x:y", corners: "soft", font: "system" };
    expect(brandingCss(bad as ThemeSettings)).toBe("");
    expect(brandingCss({ preset: "neon" } as unknown as ThemeSettings)).toBe("");
  });
});
