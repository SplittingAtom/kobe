import type { ThemeSettings } from "@kobe/protocol";
import { BRANDING_CSS_ALLOWED, brandingCss } from "./branding-css";
import { FONT_STACK_VALUES, PRESETS, RADIUS_SCALES, RADIUS_TOKENS } from "./presets";

/**
 * The Appearance preview's CSS (KOBE-501, theming plan §6): two preview roots, one light and one
 * dark whatever the admin's own theme, each styled by the real `brandingCss(theme, "#<root>")`.
 *
 * brandingCss only overrides what a theme changes, so each root first gets a scoped copy of
 * theme.css's defaults (the default preset's values, the status colours the preview shows, the
 * logo's light/dark switch) and the aliases that read the brand tokens: a custom property that
 * reads another one is resolved where it is declared, so `--admin-accent: var(--kobe-brand-link)`
 * on :root would ignore the preview's own link colour. The dark root is `data-theme="dark"`, so
 * brandingCss's chosen-dark block applies to it and its OS-dark block never touches the light one.
 * Ordering and specificity: `#root` (defaults, then the theme's light block) under
 * `#root[data-theme="dark"]` (defaults, then the theme's dark block).
 */

export const PREVIEW_IDS = { light: "preview-light", dark: "preview-dark" } as const;

/** Fixed (never themed) tokens the preview reads, as theme.css sets them (preview-css.test.ts). */
const FIXED = {
  light: {
    "--kobe-status-running": "#166534",
    "--kobe-status-running-bg": "#dcfce7",
    "--kobe-status-attention": "#a14b05",
    "--kobe-status-attention-bg": "#fef3c7",
    "--kobe-status-failed": "#b91c1c",
    "--kobe-status-failed-bg": "#fee2e2",
    "--admin-danger": "#a4161a",
    "--admin-danger-bg": "#fdecec",
    "--kobe-when-light": "block",
    "--kobe-when-dark": "none",
  },
  dark: {
    "--kobe-status-running": "#4ade80",
    "--kobe-status-running-bg": "#052e16",
    "--kobe-status-attention": "#fbbf24",
    "--kobe-status-attention-bg": "#422006",
    "--kobe-status-failed": "#f87171",
    "--kobe-status-failed-bg": "#450a0a",
    "--admin-danger": "#ff8a8a",
    "--admin-danger-bg": "#3a1c1e",
    "--kobe-when-light": "none",
    "--kobe-when-dark": "block",
  },
} as const;

export const PREVIEW_FIXED_TOKENS = Object.keys(
  FIXED.light,
) as readonly (keyof typeof FIXED.light)[];

/** theme.css's aliases of the brand tokens, declared again on each root (see above). */
const ALIASES = [
  ["--admin-accent", "var(--kobe-brand-link)"],
  ["--kobe-status-accent", "var(--kobe-brand-primary)"],
  ["--kobe-status-accent-fg", "var(--kobe-brand-primary-fg)"],
] as const;

type Decls = readonly (readonly [string, string])[];

const rule = (selector: string, decls: Decls): string =>
  `${selector} {\n${decls.map(([n, v]) => `  ${n}: ${v};\n`).join("")}}\n`;

const schemeDecls = (scheme: "light" | "dark"): Decls => [
  ["color-scheme", scheme],
  ...Object.entries(PRESETS.default[scheme]),
  ...Object.entries(FIXED[scheme]),
];

const shared: Decls = [
  ...RADIUS_TOKENS.map((t) => [t, RADIUS_SCALES.soft[t]] as const),
  ["--kobe-font-sans", FONT_STACK_VALUES.system],
  ...ALIASES,
];

/** The preview's whole stylesheet for `theme`; "" if it ever left the allow-list. */
export function previewCss(theme: ThemeSettings): string {
  const light = `#${PREVIEW_IDS.light}`;
  const dark = `#${PREVIEW_IDS.dark}`;
  const css = [
    rule(light, [...schemeDecls("light"), ...shared]),
    rule(dark, shared),
    rule(`${dark}[data-theme="dark"]`, schemeDecls("dark")),
    brandingCss(theme, light),
    brandingCss(theme, dark),
  ].join("");
  return BRANDING_CSS_ALLOWED.test(css) ? css : "";
}
