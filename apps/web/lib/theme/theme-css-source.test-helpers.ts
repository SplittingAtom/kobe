import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Test helpers (KOBE-500): app/theme.css as token maps per scheme, and CSS block parsing shared by
 * the preset and branding-css tests. Effective dark values are the dark block over the light one.
 */
export function block(source: string, prelude: string): string {
  const re = new RegExp(`(^|[}\\s;])${prelude.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
  const m = re.exec(source);
  if (!m) throw new Error(`no block ${prelude}`);
  let depth = 1;
  const start = m.index + m[0].length;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i);
  }
  throw new Error(`unclosed block ${prelude}`);
}

export function declarations(body: string): [string, string][] {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      return [
        d.slice(0, i).trim(),
        d
          .slice(i + 1)
          .trim()
          .replace(/\s+/g, " "),
      ];
    });
}

const THEME_CSS = readFileSync(
  fileURLToPath(new URL("../../app/theme.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

export const THEME_LIGHT: ReadonlyMap<string, string> = new Map(
  declarations(block(THEME_CSS, ":root")),
);
export const THEME_DARK: ReadonlyMap<string, string> = new Map([
  ...THEME_LIGHT,
  ...declarations(block(THEME_CSS, ':root[data-theme="dark"]')),
]);

/** `#rrggbb`, or an achromatic `oklch(L 0 0)` as its grey (linear channel L³); else null. */
export function asHex(value: string): string | null {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const grey = /^oklch\(([\d.]+) 0 0\)$/.exec(value);
  if (!grey) return null;
  const linear = Number(grey[1]) ** 3;
  const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  const byte = Math.round(Math.min(1, Math.max(0, srgb)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${byte}${byte}${byte}`;
}
