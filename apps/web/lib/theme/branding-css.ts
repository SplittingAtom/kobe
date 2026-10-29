import { ACCENT_PATTERN, deriveAccent, type ThemeSettings } from "@kobe/protocol";
import {
  FONT_STACK_VALUES,
  PRESET_SCHEME_TOKENS,
  PRESETS,
  RADIUS_SCALES,
  RADIUS_TOKENS,
} from "./presets";

/**
 * The site theme as CSS (theming plan TH5, §4.3): token declarations only, in theme.css's three
 * blocks (the light values on `scope`, the chosen-dark block and the OS-dark block, identical), for
 * the root layout's nonced `<style>` and the Appearance preview (`brandingCss(theme, "#preview")`).
 *
 * Nothing here is free text (TH2, security review §7): presets are constants, a custom theme's
 * accent is a validated `#rrggbb` turned into hex by deriveAccent(), corners and typeface pick from
 * closed tables. The output is checked against {@link BRANDING_CSS_ALLOWED} before it is returned,
 * and anything else yields "" (the defaults). `{ preset: "default" }` is theme.css itself, so it
 * returns "" too: with nothing configured the page is exactly today's.
 *
 * Declared: the brand tokens, the radius scale and `--kobe-font-sans`; a preset adds its neutral
 * sets; both point the chat's `--ring` and the composer's outline at the brand focus (TH3).
 */

/** Every character the output may contain (the plan's allow-list, §4.3). */
export const BRANDING_CSS_ALLOWED = /^[\s\w:;{}()#.,%/@"=[\]-]*$/;

/** `:root`, or an element id (the Appearance preview roots). */
const SCOPE = /^(?::root|#[A-Za-z][\w-]*)$/;

type Declarations = readonly (readonly [string, string])[];

const rule = (selector: string, decls: Declarations): string =>
  `${selector} {\n${decls.map(([name, value]) => `  ${name}: ${value};\n`).join("")}}\n`;

function render(scope: string, light: Declarations, dark: Declarations): string {
  const darkBody = rule(`${scope}[data-theme="dark"]`, dark);
  const osDark = rule(`${scope}:not([data-theme="light"])`, dark)
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
  return `${rule(scope, light)}${darkBody}@media (prefers-color-scheme: dark) {\n${osDark}}\n`;
}

function shape(theme: ThemeSettings): { light: Declarations; dark: Declarations } | null {
  if (theme.preset === "default") return null;
  if (theme.preset === "custom") {
    if (!ACCENT_PATTERN.test(theme.accent)) return null;
    const d = deriveAccent(theme.accent);
    const scheme = (link: string, focus: string): Declarations => [
      ["--kobe-brand-primary", d.primary],
      ["--kobe-brand-primary-hover", d.primaryHover],
      ["--kobe-brand-primary-fg", d.primaryFg],
      ["--kobe-brand-link", link],
      ["--kobe-brand-focus", focus],
      ["--ring", "var(--kobe-brand-focus)"],
      ["--kobe-composer-focus", "var(--kobe-brand-focus)"],
    ];
    return {
      light: [
        ...scheme(d.link.light, d.focus.light),
        ...RADIUS_TOKENS.map((t) => [t, RADIUS_SCALES[theme.corners][t]] as const),
        ["--kobe-font-sans", FONT_STACK_VALUES[theme.font]],
      ],
      dark: scheme(d.link.dark, d.focus.dark),
    };
  }
  const preset = PRESETS[theme.preset];
  if (preset === undefined) return null;
  return {
    light: [
      ...PRESET_SCHEME_TOKENS.map((t) => [t, preset.light[t]] as const),
      ...RADIUS_TOKENS.map((t) => [t, RADIUS_SCALES[preset.corners][t]] as const),
      ["--kobe-font-sans", FONT_STACK_VALUES[preset.font]],
    ],
    dark: PRESET_SCHEME_TOKENS.map((t) => [t, preset.dark[t]] as const),
  };
}

export function brandingCss(theme: ThemeSettings, scope = ":root"): string {
  if (!SCOPE.test(scope))
    throw new Error(`brandingCss: unsupported scope ${JSON.stringify(scope)}`);
  const blocks = shape(theme);
  if (blocks === null) return "";
  const css = render(scope, blocks.light, blocks.dark);
  return BRANDING_CSS_ALLOWED.test(css) ? css : "";
}
