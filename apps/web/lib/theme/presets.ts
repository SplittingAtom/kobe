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

/**
 * The Conversation tree's lane colours (CT7, KOBE-545): lane 1 is the path on screen, the accent
 * as text on the page (`var(--kobe-brand-link)`, so a custom accent moves it too); lanes 2-8 are
 * distinct hues per preset, rotated from its accent, each at least 3:1 (WCAG 1.4.11) on every page
 * and panel surface of its scheme (presets.test.ts).
 */
export const LANE_TOKENS = [
  "--kobe-lane-1",
  "--kobe-lane-2",
  "--kobe-lane-3",
  "--kobe-lane-4",
  "--kobe-lane-5",
  "--kobe-lane-6",
  "--kobe-lane-7",
  "--kobe-lane-8",
] as const;
export type LaneToken = (typeof LANE_TOKENS)[number];

/** Lane 1 in every preset and scheme: the accent's link colour. */
export const LANE_1_VALUE = "var(--kobe-brand-link)";

/**
 * The glow, the page ambient and the shadows (KOBE-550, docs/theming.md §7). Every preset sets
 * them: all but `catalyst` glow in their own brand colour (the theme.css expression), paint no
 * ambient and keep today's shadows; `catalyst` carries the Catalyst query tool's own values.
 */
export const GLOW_TOKENS = [
  "--kobe-glow-color",
  "--kobe-page-ambient",
  "--kobe-shadow-pop",
  "--kobe-shadow-drawer",
  "--kobe-shadow-panel",
] as const;
export type GlowToken = (typeof GLOW_TOKENS)[number];

/** theme.css's values: the brand primary at 28%, no ambient, the neutral shadows. */
export const DEFAULT_GLOW: Readonly<Record<GlowToken, string>> = {
  "--kobe-glow-color": "color-mix(in oklab, var(--kobe-brand-primary) 28%, transparent)",
  "--kobe-page-ambient": "none",
  "--kobe-shadow-pop": "0 4px 16px rgb(0 0 0 / 15%)",
  "--kobe-shadow-drawer": "0 8px 24px rgb(0 0 0 / 12%)",
  "--kobe-shadow-panel": "0 1.5rem 4rem rgb(0 0 0 / 25%)",
};

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
  ...LANE_TOKENS,
  ...GLOW_TOKENS,
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

/**
 * The shipped faces' CSS variables (KOBE-555): next/font/local declares them on <html>
 * (app/faces.ts). A stack names one as `var(<variable>, <family>)`, so it still reads the face if
 * the variable is missing.
 */
export const FACE_VARIABLES = {
  outfit: "--kobe-face-outfit",
  jetbrainsMono: "--kobe-face-jetbrains-mono",
} as const;

const GROTESK = 'Inter, Roboto, "Helvetica Neue", "Arial Nova", "Nimbus Sans", Arial, sans-serif';
/** theme.css's `--kobe-font-mono`. */
const SYSTEM_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * `--kobe-font-sans` per typeface (§5); `system` is today's. System stacks, except `catalyst`,
 * which starts with the shipped Outfit (TH10 as amended, KOBE-555).
 */
export const FONT_STACK_VALUES: Readonly<Record<FontStack, string>> = {
  system:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
  humanist:
    'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
  grotesk: GROTESK,
  serif: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
  catalyst: `var(${FACE_VARIABLES.outfit}, Outfit), ${GROTESK}`,
};

/** `--kobe-font-mono` per typeface (§5): the system stack, `catalyst` starts with JetBrains Mono. */
export const MONO_STACK_VALUES: Readonly<Record<FontStack, string>> = {
  system: SYSTEM_MONO,
  humanist: SYSTEM_MONO,
  grotesk: SYSTEM_MONO,
  serif: SYSTEM_MONO,
  catalyst: `var(${FACE_VARIABLES.jetbrainsMono}, "JetBrains Mono"), ${SYSTEM_MONO}`,
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

type Lanes = readonly [string, string, string, string, string, string, string];

function laneValues(lanes: Lanes): Readonly<Record<LaneToken, string>> {
  return {
    "--kobe-lane-1": LANE_1_VALUE,
    "--kobe-lane-2": lanes[0],
    "--kobe-lane-3": lanes[1],
    "--kobe-lane-4": lanes[2],
    "--kobe-lane-5": lanes[3],
    "--kobe-lane-6": lanes[4],
    "--kobe-lane-7": lanes[5],
    "--kobe-lane-8": lanes[6],
  };
}

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
  /** Lanes 2-8 of the Conversation tree. */
  lanes: Lanes;
  /** The glow, ambient and shadows (§7); theme.css's unless the preset says otherwise. */
  glow?: Partial<Record<GlowToken, string>>;
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
    ...laneValues(v.lanes),
    ...DEFAULT_GLOW,
    ...v.glow,
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
    ...laneValues(["#926e02", "#b54877", "#048872", "#9057b4", "#548508", "#ba4f23", "#03819e"]),
    ...DEFAULT_GLOW,
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
    ...laneValues(["#cea608", "#f67fa5", "#0ec5af", "#cf8bea", "#7ec05b", "#f78953", "#0bbcee"]),
    ...DEFAULT_GLOW,
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
    lanes: ["#936d32", "#9a5e80", "#378568", "#7d68a1", "#6d7c3d", "#a35f54", "#1c8292"],
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
    lanes: ["#caa468", "#d694b4", "#6ebda1", "#b79dda", "#9fb575", "#dd9686", "#60bacd"],
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
    lanes: ["#a05986", "#4077b3", "#9c681a", "#008491", "#ac5950", "#7c65ad", "#707c27"],
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
    lanes: ["#d88fc2", "#71b0ed", "#d89d5a", "#3ebfca", "#e88e89", "#ae9dea", "#aab25d"],
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
    lanes: ["#4d853c", "#ac5c2d", "#0180a7", "#ad536c", "#07877b", "#8b7203", "#5f6dba"],
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
    lanes: ["#82bd73", "#e89364", "#49b9e7", "#ea89a1", "#32c3b4", "#c3a948", "#94a4f6"],
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
    lanes: ["#06829c", "#5b8314", "#8c5ab2", "#946d04", "#4970c6", "#04886f", "#b04c7a"],
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
    lanes: ["#32b8f4", "#71c16f", "#d58bdd", "#c2ab2c", "#98a1fe", "#05c4ba", "#f48399"],
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
    lanes: ["#976c07", "#af4d7f", "#03896b", "#885cb5", "#618204", "#b75036", "#068298"],
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
    lanes: ["#d4a22a", "#ee83b0", "#05c7a4", "#c591ed", "#8fbc56", "#f48965", "#00bee4"],
  }),
};

/**
 * The Catalyst query tool's look (KOBE-550, Chris 2026-11-06): its light palette and its dark
 * "Rehoboam" palette (catalyst-tokens.css), borders that are the accent at 12% in the dark, the
 * tool's own glow colour per scheme, glow shadows under menus, drawers and panels, and the dark
 * page's ambient wash. Lifted a step to meet the floor (§8): the dark muted text (`#6b7694`) and
 * control borders on its near-black surfaces, and the light page and soft surfaces (`#f0f2f5`,
 * `#e8ecf4`), so the fixed "done" green keeps 4.5:1 on the muted panel. Its typefaces, Outfit and
 * JetBrains Mono, ship with the web app (KOBE-555, TH10 as amended): the `catalyst` stacks.
 */
const CATALYST_GLOW_SHADOWS = {
  "--kobe-shadow-pop": "0 0 24px var(--kobe-glow-color)",
  "--kobe-shadow-drawer": "0 0 32px var(--kobe-glow-color)",
  "--kobe-shadow-panel": "0 0 40px var(--kobe-glow-color)",
} as const;

const CATALYST: Preset = {
  id: "catalyst",
  label: PRESET_LABELS.catalyst,
  corners: "soft",
  font: "catalyst",
  light: scheme({
    page: "#f3f5f9",
    text: "#0a0e1a",
    card: "#ffffff",
    fill: "#1565c0",
    fillText: "#ffffff",
    soft: "#eff2f7",
    softText: "#0a0e1a",
    muted: "#5c6478",
    border: "#d0d6e2",
    input: "#bcc3d4",
    primary: "#1565c0",
    primaryHover: "#0d47a1",
    primaryFg: "#ffffff",
    link: "#1565c0",
    focus: "#1565c0",
    consolePanel: "#ffffff",
    controlBorder: "#6f7a94",
    overlay: "rgb(10 14 26 / 50%)",
    composerFocus: "#1565c0",
    lanes: ["#8a6500", "#ad1457", "#00897b", "#6a1b9a", "#558b2f", "#d84315", "#00838f"],
    glow: { "--kobe-glow-color": "rgb(25 118 210 / 30%)", ...CATALYST_GLOW_SHADOWS },
  }),
  dark: scheme({
    page: "#06080e",
    text: "#c8d2e0",
    card: "#0c0f18",
    fill: "#4fc3f7",
    fillText: "#06080e",
    soft: "#141828",
    softText: "#c8d2e0",
    muted: "#7f8aa8",
    border: "rgb(79 195 247 / 12%)",
    input: "rgb(79 195 247 / 15%)",
    primary: "#4fc3f7",
    primaryHover: "#81d4fa",
    primaryFg: "#06080e",
    link: "#4fc3f7",
    focus: "#4fc3f7",
    consolePanel: "#10131e",
    controlBorder: "#56688c",
    overlay: "rgb(0 0 0 / 70%)",
    composerFocus: "#4fc3f7",
    lanes: ["#ffa726", "#f06292", "#66bb6a", "#ab47bc", "#d4e157", "#ff7043", "#26a69a"],
    glow: {
      "--kobe-glow-color": "rgb(79 195 247 / 25%)",
      "--kobe-page-ambient":
        "radial-gradient(ellipse 80% 60% at 50% -10%, rgb(79 195 247 / 4%) 0%, transparent 60%), radial-gradient(ellipse 60% 40% at 80% 100%, rgb(79 195 247 / 2%) 0%, transparent 50%)",
      ...CATALYST_GLOW_SHADOWS,
    },
  }),
};

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  default: DEFAULT_PRESET,
  slate: SLATE,
  forest: FOREST,
  plum: PLUM,
  ember: EMBER,
  "tokyo-nights": TOKYO_NIGHTS,
  catalyst: CATALYST,
};
