import localFont from "next/font/local";

/**
 * The shipped faces (KOBE-555, TH10 as amended 2026-11-07: system stacks by default; a preset may
 * name a shipped face). Both are SIL OFL 1.1 (docs/licensing.md), self-hosted from the web image:
 * next/font serves them from `/_next/static/media` (`font-src 'self'`), never from Google Fonts.
 * The files are the projects' variable fonts, converted from TTF to WOFF2 and otherwise unmodified,
 * under their own names with their OFL.txt beside them (provenance in docs/ledger/KOBE-555.md).
 *
 * Each face only sets a CSS variable on <html>; a font stack names it (`FACE_VARIABLES` and the
 * `catalyst` stacks in lib/theme/presets.ts), so the faces load only on a page whose theme uses
 * them: no preload, and the stack's own system fallbacks follow (no metric-adjusted Arial).
 * next/font needs literal options, so the variable names are spelled out here and app/faces.test.ts
 * checks them against FACE_VARIABLES.
 */
const outfit = localFont({
  src: "./fonts/outfit/Outfit[wght].woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--kobe-face-outfit",
  preload: false,
  adjustFontFallback: false,
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono/JetBrainsMono[wght].woff2",
  weight: "100 800",
  style: "normal",
  display: "swap",
  variable: "--kobe-face-jetbrains-mono",
  preload: false,
  adjustFontFallback: false,
});

/** The classes that declare the face variables; the root layout puts them on <html>. */
export const FACE_CLASSES = `${outfit.variable} ${jetbrainsMono.variable}`;
