/**
 * The inline logo (KOBE-562, docs/theming.md §2.1): with "Logo takes the theme colour" on, the
 * server derives an inline-safe variant of an SVG logo (`services/server/src/branding/svg-themed.ts`)
 * and the page inserts it, so the drawing takes `currentColor`. The web never inlines the raw upload:
 * only the variant's URL (`logo.inline`), and the markup is checked again here before it reaches
 * the DOM (defence in depth: the server's allowlist is the rule, this refuses anything it would
 * never write).
 */

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg"';
/** The upload cap is 512 KiB; the variant is smaller than its source. */
export const INLINE_LOGO_MAX_CHARS = 1024 * 1024;

const REFUSED: readonly RegExp[] = [
  /<(?:script|style|foreignobject|image|img|iframe|object|embed|a|animate|set|link|meta)[\s/>]/i,
  /[\s/"']on[a-z]+\s*=/i,
  /[\s/"']style\s*=/i,
  /javascript:|data:/i,
  /href\s*=\s*"(?!#kobe-logo-)/i,
  /url\(\s*(?!#kobe-logo-)/i,
  /[\s/"']id\s*=\s*"(?!kobe-logo-)/i,
];

/** The markup when it is the server's variant, else null (then the page shows the image). */
export function inlineSafeMarkup(text: string): string | null {
  const markup = text.trim();
  if (markup.length > INLINE_LOGO_MAX_CHARS) return null;
  if (!markup.startsWith(`${SVG_OPEN} `) && !markup.startsWith(`${SVG_OPEN}>`)) return null;
  // One root: the only </svg> is the last thing (nested <svg> is not written by the server).
  if (!markup.endsWith("</svg>") || markup.indexOf("</svg>") !== markup.length - 6) return null;
  return REFUSED.some((re) => re.test(markup)) ? null : markup;
}

const side = (n: number | undefined, name: string): string =>
  n !== undefined && Number.isFinite(n) && n > 0 ? `${name}="${Math.round(n)}" ` : "";

/** The variant with its rendered size, decorative (the name beside it is the accessible name). */
export function sizedLogoMarkup(markup: string, width?: number, height?: number): string {
  const attributes = `${side(width, "width")}${side(height, "height")}focusable="false" aria-hidden="true" `;
  return `<svg ${attributes}${markup.slice("<svg ".length)}`;
}

const known = new Map<string, Promise<string | null>>();

/**
 * The variant at `url` (a same-origin path the branding named), fetched once per page; null when
 * it cannot be fetched or is not the server's variant. Browser only (the Appearance preview); the
 * server render gets the markup from lib/theme/branding-server.ts.
 */
export function fetchInlineLogo(
  url: string,
  doFetch: typeof fetch = fetch,
): Promise<string | null> {
  let pending = known.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await doFetch(url, { credentials: "same-origin" });
        const type = response.headers.get("content-type") ?? "";
        if (!response.ok || !type.startsWith("image/svg+xml")) return null;
        return inlineSafeMarkup(await response.text());
      } catch {
        return null;
      }
    })();
    known.set(url, pending);
  }
  return pending;
}
