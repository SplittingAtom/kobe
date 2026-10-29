import type { ThemeSettings } from "../branding.js";
import { adjustLightness, contrastRatio } from "./colour.js";

/**
 * Accent derivation and the contrast floor (TH4; rules in docs/theming.md §8). The same functions
 * run in the web (theme CSS for a custom accent) and on the server (`PUT /v1/site/branding`).
 */

/** The backgrounds an accent is measured against, as `#rrggbb`. */
export interface Surfaces {
  readonly page: string;
  readonly panel: string;
  readonly card: string;
}

/** The default preset's console neutrals (apps/web/app/theme.css). */
export const DEFAULT_SURFACES: Readonly<{ light: Surfaces; dark: Surfaces }> = Object.freeze({
  light: Object.freeze({ page: "#ffffff", panel: "#f4f4f6", card: "#ffffff" }),
  dark: Object.freeze({ page: "#16161a", panel: "#202027", card: "#202027" }),
});

/** A colour per scheme. */
export interface SchemePair {
  readonly light: string;
  readonly dark: string;
}

export interface DerivedAccent {
  /** Light: the accent as given; dark: the accent lightened until ≥ 3:1 on page and panel. */
  readonly primary: SchemePair;
  /** That scheme's primary one step darker. */
  readonly primaryHover: SchemePair;
  /** `#ffffff` or `#111111`, whichever contrasts more with that scheme's primary. */
  readonly primaryFg: SchemePair;
  readonly link: { readonly light: string; readonly dark: string };
  readonly focus: { readonly light: string; readonly dark: string };
}

export type FloorScheme = "light" | "dark" | "both";

export interface FloorFailure {
  readonly rule: string;
  readonly scheme: FloorScheme;
  readonly ratio: number;
  readonly required: number;
}

export interface FloorReport {
  readonly ok: boolean;
  readonly failures: readonly FloorFailure[];
  readonly derived: DerivedAccent;
}

/** WCAG AA text and non-text (1.4.11) contrast. */
export const TEXT_CONTRAST_MIN = 4.5;
export const NON_TEXT_CONTRAST_MIN = 3;

/** The default preset's light accent (theme.css), used for `derived` of a preset theme. */
export const DEFAULT_ACCENT = "#2449c7";

const LIGHT_FG = "#ffffff";
const DARK_FG = "#111111";
/** OKLCH lightness of one "step" (the hover) and of one search increment. */
const HOVER_STEP = 0.06;
const SEARCH_STEP = 0.01;
const MAX_STEPS = 100;

type SurfaceSet = Readonly<{ light: Surfaces; dark: Surfaces }>;

const minRatio = (colour: string, backgrounds: readonly string[]): number =>
  Math.min(...backgrounds.map((bg) => contrastRatio(colour, bg)));

/** Moves `start` by `direction` steps until it reaches `required` on all `backgrounds`. */
function adjustUntil(
  start: string,
  backgrounds: readonly string[],
  required: number,
  direction: 1 | -1,
): string {
  let colour = start;
  for (let i = 0; i < MAX_STEPS && minRatio(colour, backgrounds) < required; i += 1) {
    colour = adjustLightness(start, direction * SEARCH_STEP * (i + 1));
  }
  return colour;
}

/** The brand colours derived from one accent (TH3/TH4). */
export function deriveAccent(
  accent: string,
  surfaces: SurfaceSet = DEFAULT_SURFACES,
): DerivedAccent {
  const { light, dark } = surfaces;
  const accentHex = accent.toLowerCase();
  const primary = {
    light: accentHex,
    dark: adjustUntil(accentHex, [dark.page, dark.panel], NON_TEXT_CONTRAST_MIN, 1),
  };
  const primaryHover = {
    light: adjustLightness(primary.light, -HOVER_STEP),
    dark: adjustLightness(primary.dark, -HOVER_STEP),
  };
  const fgOn = (fill: string) =>
    contrastRatio(LIGHT_FG, fill) >= contrastRatio(DARK_FG, fill) ? LIGHT_FG : DARK_FG;
  const primaryFg = { light: fgOn(primary.light), dark: fgOn(primary.dark) };
  const linkLight = adjustUntil(accentHex, [light.page, light.panel], TEXT_CONTRAST_MIN, -1);
  const linkDark = adjustUntil(accentHex, [dark.page, dark.panel], TEXT_CONTRAST_MIN, 1);
  const focusLight = adjustUntil(
    linkLight,
    [light.page, light.panel, light.card],
    NON_TEXT_CONTRAST_MIN,
    -1,
  );
  const focusDark = adjustUntil(
    linkDark,
    [dark.page, dark.panel, dark.card],
    NON_TEXT_CONTRAST_MIN,
    1,
  );
  return {
    primary,
    primaryHover,
    primaryFg,
    link: { light: linkLight, dark: linkDark },
    focus: { light: focusLight, dark: focusDark },
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function check(
  failures: FloorFailure[],
  rule: string,
  scheme: FloorScheme,
  ratio: number,
  required: number,
): void {
  if (ratio < required) failures.push({ rule, scheme, ratio: round2(ratio), required });
}

/**
 * The contrast floor (docs/theming.md §8 rules 2-4) for a theme. Presets pass by construction
 * (their own test in the web), so only a custom accent is measured.
 */
export function checkFloor(
  theme: ThemeSettings,
  surfaces: SurfaceSet = DEFAULT_SURFACES,
): FloorReport {
  const accent = theme.preset === "custom" ? theme.accent : DEFAULT_ACCENT;
  const derived = deriveAccent(accent, surfaces);
  if (theme.preset !== "custom") return { ok: true, failures: [], derived };
  const failures: FloorFailure[] = [];
  const { primary, primaryHover, primaryFg, link, focus } = derived;
  for (const scheme of ["light", "dark"] as const) {
    const s = surfaces[scheme];
    // The fill stands out from the surfaces (WCAG 1.4.11): no white buttons on a white page.
    for (const surface of ["page", "panel"] as const) {
      check(
        failures,
        "primary_on_surface",
        scheme,
        contrastRatio(primary[scheme], s[surface]),
        NON_TEXT_CONTRAST_MIN,
      );
    }
    check(
      failures,
      "fg_on_primary",
      scheme,
      contrastRatio(primaryFg[scheme], primary[scheme]),
      TEXT_CONTRAST_MIN,
    );
    check(
      failures,
      "fg_on_hover",
      scheme,
      contrastRatio(primaryFg[scheme], primaryHover[scheme]),
      TEXT_CONTRAST_MIN,
    );
    for (const surface of ["page", "panel"] as const) {
      check(
        failures,
        `link on ${surface}`,
        scheme,
        contrastRatio(link[scheme], s[surface]),
        TEXT_CONTRAST_MIN,
      );
    }
    for (const surface of ["page", "panel", "card"] as const) {
      check(
        failures,
        `focus on ${surface}`,
        scheme,
        contrastRatio(focus[scheme], s[surface]),
        NON_TEXT_CONTRAST_MIN,
      );
    }
  }
  return { ok: failures.length === 0, failures, derived };
}
