import type { CornerStyle, FontStack, PresetId } from "@kobe/protocol";
import { PRESET_LABELS } from "@kobe/protocol";

/**
 * The shipped presets (theming plan TH9; catalogue docs/theming.md §3-§6). A preset is a complete
 * set of values, light and dark, for every token marked "preset" in the catalogue: the brand
 * tokens (§4.1), both neutral sets (§4.2, the chat's shadcn names and the consoles'), the focus
 * outlines that follow the brand (the chat's `--ring`, the composer's outline; TH3), plus a corner
 * scale (§6) and a typeface stack (§5). `default` is today's look: its values are theme.css's,
 * byte for byte (presets.test.ts parses theme.css to prove it), so it needs no override at all.
 * Every preset meets the floor of §8 in both schemes (presets.test.ts).
 *
 * Status, danger, confirm, tool, diff and context-viewer colours are not here: they are fixed
 * (§4.4), and the test checks they keep their contrast on each preset's surfaces.
 */

/** Tokens a preset sets per scheme, in theme.css order. */
export const PRESET_SCHEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--ring",
  "--kobe-brand-primary",
  "--kobe-brand-primary-hover",
  "--kobe-brand-primary-fg",
  "--kobe-brand-link",
  "--kobe-brand-focus",
  "--kobe-console-fg",
  "--kobe-console-muted",
  "--kobe-console-bg",
  "--kobe-console-panel",
  "--kobe-console-border",
  "--kobe-console-control-border",
  "--kobe-console-overlay",
  "--kobe-composer-focus",
] as const;
export type PresetSchemeToken = (typeof PRESET_SCHEME_TOKENS)[number];
export type SchemeValues = Readonly<Record<PresetSchemeToken, string>>;

export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  readonly corners: CornerStyle;
  readonly font: FontStack;
  readonly light: SchemeValues;
  readonly dark: SchemeValues;
}

/** `--kobe-font-sans` per typeface (§5); `system` is today's. All system stacks: no font files. */
export const FONT_STACK_VALUES: Readonly<Record<FontStack, string>> = {
  system:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
  humanist:
    'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
  grotesk: 'Inter, Roboto, "Helvetica Neue", "Arial Nova", "Nimbus Sans", Arial, sans-serif',
  serif: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
};

export const RADIUS_TOKENS = [
  "--kobe-radius-sm",
  "--kobe-radius-md",
  "--kobe-radius-lg",
  "--kobe-radius-xl",
  "--kobe-radius-pill",
] as const;
export type RadiusToken = (typeof RADIUS_TOKENS)[number];

/** The radius scales (§6); `soft` is today's. */
export const RADIUS_SCALES: Readonly<Record<CornerStyle, Readonly<Record<RadiusToken, string>>>> = {
  sharp: {
    "--kobe-radius-sm": "0",
    "--kobe-radius-md": "0",
    "--kobe-radius-lg": "0",
    "--kobe-radius-xl": "0",
    "--kobe-radius-pill": "0",
  },
  soft: {
    "--kobe-radius-sm": "0.25rem",
    "--kobe-radius-md": "0.375rem",
    "--kobe-radius-lg": "0.5rem",
    "--kobe-radius-xl": "0.75rem",
    "--kobe-radius-pill": "9999px",
  },
  round: {
    "--kobe-radius-sm": "0.5rem",
    "--kobe-radius-md": "0.75rem",
    "--kobe-radius-lg": "1rem",
    "--kobe-radius-xl": "1.25rem",
    "--kobe-radius-pill": "9999px",
  },
};

/** One scheme from its parts, so each preset below reads as a palette. */
function scheme(v: {
  page: string;
  text: string;
  card: string;
  fill: string;
  fillText: string;
  soft: string;
  softText: string;
  muted: string;
  border: string;
  input: string;
  primary: string;
  primaryHover: string;
  primaryFg: string;
  link: string;
  focus: string;
  consolePanel: string;
  controlBorder: string;
  overlay: string;
  composerFocus: string;
}): SchemeValues {
  return {
    "--background": v.page,
    "--foreground": v.text,
    "--card": v.card,
    "--card-foreground": v.text,
    "--popover": v.card,
    "--popover-foreground": v.text,
    "--primary": v.fill,
    "--primary-foreground": v.fillText,
    "--secondary": v.soft,
    "--secondary-foreground": v.softText,
    "--muted": v.soft,
    "--muted-foreground": v.muted,
    "--accent": v.soft,
    "--accent-foreground": v.softText,
    "--border": v.border,
    "--input": v.input,
    "--ring": v.focus,
    "--kobe-brand-primary": v.primary,
    "--kobe-brand-primary-hover": v.primaryHover,
    "--kobe-brand-primary-fg": v.primaryFg,
    "--kobe-brand-link": v.link,
    "--kobe-brand-focus": v.focus,
    "--kobe-console-fg": v.text,
    "--kobe-console-muted": v.muted,
    "--kobe-console-bg": v.page,
    "--kobe-console-panel": v.consolePanel,
    "--kobe-console-border": v.border,
    "--kobe-console-control-border": v.controlBorder,
    "--kobe-console-overlay": v.overlay,
    "--kobe-composer-focus": v.composerFocus,
  };
}

/** Today's look, as app/theme.css declares it (the hover is the same color-mix in both schemes). */
const DEFAULT_PRESET: Preset = {
  id: "default",
  label: PRESET_LABELS.default,
  corners: "soft",
  font: "system",
  light: {
    "--background": "oklch(1 0 0)",
    "--foreground": "oklch(0.145 0 0)",
    "--card": "oklch(1 0 0)",
    "--card-foreground": "oklch(0.145 0 0)",
    "--popover": "oklch(1 0 0)",
    "--popover-foreground": "oklch(0.145 0 0)",
    "--primary": "oklch(0.205 0 0)",
    "--primary-foreground": "oklch(0.985 0 0)",
    "--secondary": "oklch(0.97 0 0)",
    "--secondary-foreground": "oklch(0.205 0 0)",
    "--muted": "oklch(0.97 0 0)",
    "--muted-foreground": "oklch(0.556 0 0)",
    "--accent": "oklch(0.97 0 0)",
    "--accent-foreground": "oklch(0.205 0 0)",
    "--border": "oklch(0.922 0 0)",
    "--input": "oklch(0.922 0 0)",
    "--ring": "oklch(0.708 0 0)",
    "--kobe-brand-primary": "#2449c7",
    "--kobe-brand-primary-hover": "color-mix(in oklab, var(--kobe-brand-primary) 90%, transparent)",
    "--kobe-brand-primary-fg": "#ffffff",
    "--kobe-brand-link": "#2449c7",
    "--kobe-brand-focus": "#2449c7",
    "--kobe-console-fg": "#1b1b1f",
    "--kobe-console-muted": "#5b5b66",
    "--kobe-console-bg": "#ffffff",
    "--kobe-console-panel": "#f4f4f6",
    "--kobe-console-border": "#d9d9df",
    "--kobe-console-control-border": "#80808c",
    "--kobe-console-overlay": "rgb(0 0 0 / 50%)",
    "--kobe-composer-focus": "#52525b",
  },
  dark: {
    "--background": "oklch(0.145 0 0)",
    "--foreground": "oklch(0.985 0 0)",
    "--card": "oklch(0.205 0 0)",
    "--card-foreground": "oklch(0.985 0 0)",
    "--popover": "oklch(0.205 0 0)",
    "--popover-foreground": "oklch(0.985 0 0)",
    "--primary": "oklch(0.922 0 0)",
    "--primary-foreground": "oklch(0.205 0 0)",
    "--secondary": "oklch(0.269 0 0)",
    "--secondary-foreground": "oklch(0.985 0 0)",
    "--muted": "oklch(0.269 0 0)",
    "--muted-foreground": "oklch(0.708 0 0)",
    "--accent": "oklch(0.269 0 0)",
    "--accent-foreground": "oklch(0.985 0 0)",
    "--border": "oklch(1 0 0 / 10%)",
    "--input": "oklch(1 0 0 / 15%)",
    "--ring": "oklch(0.556 0 0)",
    "--kobe-brand-primary": "#4263eb",
    "--kobe-brand-primary-hover": "color-mix(in oklab, var(--kobe-brand-primary) 90%, transparent)",
    "--kobe-brand-primary-fg": "#ffffff",
    "--kobe-brand-link": "#8fa8ff",
    "--kobe-brand-focus": "#8fa8ff",
    "--kobe-console-fg": "#ececf1",
    "--kobe-console-muted": "#a5a5b2",
    "--kobe-console-bg": "#16161a",
    "--kobe-console-panel": "#202027",
    "--kobe-console-border": "#3a3a45",
    "--kobe-console-control-border": "#74747f",
    "--kobe-console-overlay": "rgb(0 0 0 / 70%)",
    "--kobe-composer-focus": "#a1a1aa",
  },
};

/** Cool blue-grey neutrals, a slate-blue accent, grotesk type. */
const SLATE: Preset = {
  id: "slate",
  label: PRESET_LABELS.slate,
  corners: "soft",
  font: "grotesk",
  light: scheme({
    page: "#f8fafc",
    text: "#0f172a",
    card: "#ffffff",
    fill: "#1e293b",
    fillText: "#f8fafc",
    soft: "#eef2f6",
    softText: "#1e293b",
    muted: "#4e5b70",
    border: "#d5dde7",
    input: "#c3cdda",
    primary: "#3d5a80",
    primaryHover: "#324b6b",
    primaryFg: "#ffffff",
    link: "#3d5a80",
    focus: "#3d5a80",
    consolePanel: "#eef2f6",
    controlBorder: "#77849a",
    overlay: "rgb(15 23 42 / 50%)",
    composerFocus: "#4e5b70",
  }),
  dark: scheme({
    page: "#0f141c",
    text: "#e5eaf1",
    card: "#18202b",
    fill: "#e2e8f0",
    fillText: "#1e293b",
    soft: "#222c3a",
    softText: "#e5eaf1",
    muted: "#a3afc0",
    border: "#2c3848",
    input: "#3a4759",
    primary: "#4a6a9e",
    primaryHover: "#5577ad",
    primaryFg: "#ffffff",
    link: "#9db6dc",
    focus: "#9db6dc",
    consolePanel: "#18202b",
    controlBorder: "#6f7d91",
    overlay: "rgb(0 0 0 / 70%)",
    composerFocus: "#a3afc0",
  }),
};

/** Green-tinted neutrals, a deep forest accent, humanist type, round corners. */
const FOREST: Preset = {
  id: "forest",
  label: PRESET_LABELS.forest,
  corners: "round",
  font: "humanist",
  light: scheme({
    page: "#fbfcfa",
    text: "#14201a",
    card: "#ffffff",
    fill: "#1d2e24",
    fillText: "#f4f8f5",
    soft: "#eef3ee",
    softText: "#1d2e24",
    muted: "#4c5e54",
    border: "#d6e0d8",
    input: "#c2cfc5",
    primary: "#2d6a4f",
    primaryHover: "#245740",
    primaryFg: "#ffffff",
    link: "#2d6a4f",
    focus: "#2d6a4f",
    consolePanel: "#eef3ee",
    controlBorder: "#72837a",
    overlay: "rgb(10 20 14 / 50%)",
    composerFocus: "#4c5e54",
  }),
  dark: scheme({
    page: "#0f1712",
    text: "#e3ece5",
    card: "#17221b",
    fill: "#dfe9e2",
    fillText: "#1d2e24",
    soft: "#1f2d24",
    softText: "#e3ece5",
    muted: "#a0b3a6",
    border: "#2b3b31",
    input: "#36493d",
    primary: "#2f7353",
    primaryHover: "#37805e",
    primaryFg: "#ffffff",
    link: "#8fd1ab",
    focus: "#8fd1ab",
    consolePanel: "#17221b",
    controlBorder: "#6c8073",
    overlay: "rgb(0 0 0 / 70%)",
    composerFocus: "#a0b3a6",
  }),
};

/** Violet-tinted neutrals, a plum accent, serif type. */
const PLUM: Preset = {
  id: "plum",
  label: PRESET_LABELS.plum,
  corners: "soft",
  font: "serif",
  light: scheme({
    page: "#fdfbfd",
    text: "#221626",
    card: "#ffffff",
    fill: "#33223a",
    fillText: "#fbf6fc",
    soft: "#f7f2f8",
    softText: "#33223a",
    muted: "#625266",
    border: "#e3d8e5",
    input: "#d2c4d5",
    primary: "#7a3e8a",
    primaryHover: "#66337a",
    primaryFg: "#ffffff",
    link: "#7a3e8a",
    focus: "#7a3e8a",
    consolePanel: "#f7f2f8",
    controlBorder: "#88788c",
    overlay: "rgb(34 22 38 / 50%)",
    composerFocus: "#625266",
  }),
  dark: scheme({
    page: "#18121a",
    text: "#eee6ef",
    card: "#221a25",
    fill: "#ece2ee",
    fillText: "#33223a",
    soft: "#2c2230",
    softText: "#eee6ef",
    muted: "#b4a6b8",
    border: "#3b2f3f",
    input: "#4a3c4f",
    primary: "#8a4a9c",
    primaryHover: "#9656a8",
    primaryFg: "#ffffff",
    link: "#d7a8e3",
    focus: "#d7a8e3",
    consolePanel: "#221a25",
    controlBorder: "#85758a",
    overlay: "rgb(0 0 0 / 70%)",
    composerFocus: "#b4a6b8",
  }),
};

/** Warm neutrals, a burnt-orange accent, grotesk type, sharp corners. */
const EMBER: Preset = {
  id: "ember",
  label: PRESET_LABELS.ember,
  corners: "sharp",
  font: "grotesk",
  light: scheme({
    page: "#fffcfa",
    text: "#24170f",
    card: "#ffffff",
    fill: "#33231a",
    fillText: "#fdf7f3",
    soft: "#faf4ef",
    softText: "#33231a",
    muted: "#65554a",
    border: "#eadbd0",
    input: "#dccabd",
    primary: "#b03d12",
    primaryHover: "#97340f",
    primaryFg: "#ffffff",
    link: "#a63a10",
    focus: "#b03d12",
    consolePanel: "#faf4ef",
    controlBorder: "#8c7b70",
    overlay: "rgb(36 23 15 / 50%)",
    composerFocus: "#65554a",
  }),
  dark: scheme({
    page: "#1a1210",
    text: "#f1e7e1",
    card: "#241a16",
    fill: "#f0e4dc",
    fillText: "#33231a",
    soft: "#30231d",
    softText: "#f1e7e1",
    muted: "#bba79b",
    border: "#3f2e26",
    input: "#4d3a30",
    primary: "#e07a3f",
    primaryHover: "#e98b53",
    primaryFg: "#111111",
    link: "#f5a571",
    focus: "#f5a571",
    consolePanel: "#241a16",
    controlBorder: "#8a776c",
    overlay: "rgb(0 0 0 / 70%)",
    composerFocus: "#bba79b",
  }),
};

/** After the Tokyo Night editor palette: indigo night, a periwinkle accent, round corners. */
const TOKYO_NIGHTS: Preset = {
  id: "tokyo-nights",
  label: PRESET_LABELS["tokyo-nights"],
  corners: "round",
  font: "system",
  light: scheme({
    page: "#f6f7fa",
    text: "#2f3550",
    card: "#ffffff",
    fill: "#343b58",
    fillText: "#f6f7fa",
    soft: "#f2f3f7",
    softText: "#2f3550",
    muted: "#4a5170",
    border: "#d6d9e4",
    input: "#c3c7d6",
    primary: "#34548a",
    primaryHover: "#2b4673",
    primaryFg: "#ffffff",
    link: "#34548a",
    focus: "#34548a",
    consolePanel: "#f2f3f7",
    controlBorder: "#6c7194",
    overlay: "rgb(26 27 38 / 50%)",
    composerFocus: "#4a5170",
  }),
  dark: scheme({
    page: "#1a1b26",
    text: "#c0caf5",
    card: "#24283b",
    fill: "#c0caf5",
    fillText: "#1a1b26",
    soft: "#292e42",
    softText: "#c0caf5",
    muted: "#a9b1d6",
    border: "#2f3549",
    input: "#3b4261",
    primary: "#7aa2f7",
    primaryHover: "#8db0f9",
    primaryFg: "#1a1b26",
    link: "#7aa2f7",
    focus: "#bb9af7",
    consolePanel: "#1f2335",
    controlBorder: "#737aa2",
    overlay: "rgb(0 0 0 / 70%)",
    composerFocus: "#a9b1d6",
  }),
};

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  default: DEFAULT_PRESET,
  slate: SLATE,
  forest: FOREST,
  plum: PLUM,
  ember: EMBER,
  "tokyo-nights": TOKYO_NIGHTS,
};
