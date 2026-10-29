import { expect, type Locator } from "@playwright/test";

export type Theme = "light" | "dark";

/** Background luminance on either side of this reads as light or dark. */
const LIGHT_ABOVE = 0.5;
/** Text and background must stay this far apart in luminance to read. */
export const MIN_CONTRAST = 0.3;

/** `paint` (of the popup `name`) reads as `theme`, with legible text. */
export function expectThemed(name: string, paint: Paint, theme: Theme): void {
  const where = `${name} in ${theme}: ${paint.background} / ${paint.text}`;
  if (theme === "light") expect(paint.backgroundLuminance, where).toBeGreaterThan(LIGHT_ABOVE);
  else expect(paint.backgroundLuminance, where).toBeLessThan(LIGHT_ABOVE);
  expect(Math.abs(paint.backgroundLuminance - paint.textLuminance), where).toBeGreaterThan(
    MIN_CONTRAST,
  );
}

/** What a popup paints: its own background (or the nearest painted ancestor's) and text colour. */
export interface Paint {
  readonly background: string;
  readonly text: string;
  /** Relative luminance (WCAG), 0 black to 1 white. */
  readonly backgroundLuminance: number;
  readonly textLuminance: number;
}

/**
 * Reads the colours of `popup` in the page; transparent layers fall through to their parent.
 * Colours go through a canvas, so any CSS colour syntax (oklch, color-mix…) reads as sRGB.
 */
export function paintOf(popup: Locator): Promise<Paint> {
  return popup.evaluate((el) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("no 2d canvas");
    const rgba = (css: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (css: string) => {
      const [r = 0, g = 0, b = 0] = rgba(css).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    let node: Element | null = el;
    let background = "rgb(255, 255, 255)";
    while (node !== null) {
      const css = getComputedStyle(node).backgroundColor;
      if ((rgba(css)[3] ?? 0) > 128) {
        background = css;
        break;
      }
      node = node.parentElement;
    }
    const text = getComputedStyle(el).color;
    return {
      background,
      text,
      backgroundLuminance: luminance(background),
      textLuminance: luminance(text),
    };
  });
}

/** WCAG contrast ratio of a paint's text on its background (1 to 21). */
export function contrastOf(paint: Paint): number {
  const hi = Math.max(paint.backgroundLuminance, paint.textLuminance);
  const lo = Math.min(paint.backgroundLuminance, paint.textLuminance);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for text (4.5:1) of `paint`, the element `name`. */
export function expectAA(name: string, paint: Paint, min = 4.5): void {
  const ratio = Math.round(contrastOf(paint) * 100) / 100;
  expect(ratio, `${name}: ${paint.text} on ${paint.background}`).toBeGreaterThanOrEqual(min);
}
