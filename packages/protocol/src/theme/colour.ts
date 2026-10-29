/**
 * Colour maths shared by the server (contrast floor on PUT, TH4) and the web (deriveAccent in the
 * theme CSS): WCAG 2.x relative luminance and contrast, and a lightness change in OKLCH (a small
 * in-house conversion; no dependency). Colours are `#rrggbb` strings.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX = /^#([0-9a-fA-F]{6})$/;

/** `#rrggbb` (either case) → 0..255 channels; throws on anything else. */
export function parseHex(hex: string): Rgb {
  const digits = HEX.exec(hex)?.[1];
  if (digits === undefined) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(digits, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

const clampByte = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));

/** 0..255 channels (rounded and clamped) → lowercase `#rrggbb`. */
export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => clampByte(c).toString(16).padStart(2, "0")).join("")}`;
}

const toLinear = (c8: number): number => {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (l: number): number => {
  const c = l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055;
  return c * 255;
};

/** WCAG 2.x relative luminance, 0 (black) .. 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio of two colours, 1..21 (order does not matter). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

function hexToOklch(hex: string): Oklch {
  const { r, g, b } = parseHex(hex);
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) };
}

function oklchToLinear({ l: L, c, h }: Oklch): [number, number, number] {
  const A = c * Math.cos(h);
  const B = c * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: readonly number[]): boolean => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/**
 * The colour with its OKLCH lightness moved by `delta` (−1..1; negative darkens), hue kept. When the
 * result leaves sRGB the chroma is reduced until it fits (binary search), so hues stay true.
 */
export function adjustLightness(hex: string, delta: number): string {
  const base = hexToOklch(hex);
  const l = Math.min(1, Math.max(0, base.l + delta));
  if (l <= 0) return "#000000";
  if (l >= 1) return "#ffffff";
  let lo = 0;
  let hi = base.c;
  let best: [number, number, number] = oklchToLinear({ l, c: 0, h: base.h });
  if (inGamut(oklchToLinear({ l, c: hi, h: base.h }))) {
    best = oklchToLinear({ l, c: hi, h: base.h });
  } else {
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      const rgb = oklchToLinear({ l, c: mid, h: base.h });
      if (inGamut(rgb)) {
        lo = mid;
        best = rgb;
      } else {
        hi = mid;
      }
    }
  }
  const [r, g, b] = best;
  const channel = (v: number): number => fromLinear(Math.min(1, Math.max(0, v)));
  return toHex({ r: channel(r), g: channel(g), b: channel(b) });
}
