import { checkSvg, length, type SvgSink } from "./svg.js";

/**
 * The themed SVG variants (KOBE-562, docs/theming.md §2.1): with "Logo takes the theme colour" on,
 * the web inlines the logo so it can take `currentColor`, and an SVG favicon follows the browser's
 * scheme. Inline SVG from an admin upload reaches every member's DOM, so the variant is rebuilt
 * from what the TH8 reader accepted (`checkSvg`'s sink: its refusals apply first), keeping only an
 * allowlist and writing every value escaped:
 *
 * - elements: shapes, `g`/`defs`/`use`/`symbol`/`clipPath`/`mask`, `text`/`tspan` (`a` and `switch`
 *   become a plain `g`); anything else (style, gradients, patterns, filters, images, animation,
 *   title, metadata, a nested `svg`, ...) is dropped with its content;
 * - attributes: geometry and presentation only; no `style`, `class`, `on*` or `color`. `style`
 *   declarations of allowlisted properties become attributes (they win, as in CSS) and the
 *   attribute is dropped;
 * - every fill and stroke becomes `currentColor` (`none`/`transparent` stay none; gradient and
 *   pattern paints too: one colour is the point); the root gets `fill="currentColor"` unless it
 *   sets a fill, so shapes that relied on the default black or a dropped `<style>` follow;
 * - ids get a per-asset prefix, as do their `url(#…)` and `href="#…"` references; an id or reference
 *   that is not a plain name is dropped; `href` only on `use`;
 * - the root's width/height are dropped (the page sizes the logo); a missing viewBox comes from them.
 */

export type ThemedSvg =
  { readonly ok: true; readonly svg: string } | { readonly ok: false; readonly reason: string };

export const LOGO_ID_PREFIX = "kobe-logo-";
export const FAVICON_ID_PREFIX = "kobe-favicon-";
/** A favicon never sees the page's CSS: fixed high-contrast colours per browser scheme. */
export const FAVICON_SCHEME_STYLE =
  "svg{color:#1b1b1f}@media (prefers-color-scheme: dark){svg{color:#ffffff}}";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Kept elements by lowercase local name, with the name they are written as. */
const ELEMENTS: ReadonlyMap<string, string> = new Map([
  ["svg", "svg"],
  ["g", "g"],
  ["a", "g"],
  ["switch", "g"],
  ["defs", "defs"],
  ["symbol", "symbol"],
  ["use", "use"],
  ["clippath", "clipPath"],
  ["mask", "mask"],
  ["path", "path"],
  ["rect", "rect"],
  ["circle", "circle"],
  ["ellipse", "ellipse"],
  ["line", "line"],
  ["polyline", "polyline"],
  ["polygon", "polygon"],
  ["text", "text"],
  ["tspan", "tspan"],
]);
const TEXT_ELEMENTS = new Set(["text", "tspan"]);

const names = (list: string): ReadonlyMap<string, string> =>
  new Map(list.split(" ").map((name) => [name.toLowerCase(), name]));

/** Geometry attributes, by lowercase name. */
const GEOMETRY = names(
  "x y x1 y1 x2 y2 cx cy r rx ry width height d points pathLength transform viewBox " +
    "preserveAspectRatio dx dy rotate textLength lengthAdjust clipPathUnits maskUnits maskContentUnits",
);
/** Presentation properties, as attributes and as `style` declarations. */
const PRESENTATION = names(
  "fill-rule clip-rule opacity fill-opacity stroke-opacity stroke-width stroke-linecap " +
    "stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset vector-effect " +
    "shape-rendering paint-order visibility display font-family font-size font-weight font-style " +
    "font-variant text-anchor dominant-baseline alignment-baseline baseline-shift letter-spacing " +
    "word-spacing text-decoration",
);
const PAINTS = new Set(["fill", "stroke"]);
/** Properties whose value is `url(#id)` or `none`. */
const REFERENCES = new Set(["clip-path", "mask"]);
const ROOT_DROPPED = new Set(["width", "height", "x", "y"]);

const ID = /^[A-Za-z_][\w.-]*$/;
const FRAGMENT_URL = /^url\(\s*(['"]?)#([^'"()\s]+)\1\s*\)$/i;

const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function paint(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === "none" || v === "transparent") return "none";
  if (v === "inherit") return "inherit";
  return "currentColor";
}

/** `name: value` pairs of a style attribute, comments and `!important` removed. */
function declarations(style: string): [string, string][] {
  return style
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .flatMap((part) => {
      const colon = part.indexOf(":");
      if (colon < 0) return [];
      const name = part.slice(0, colon).trim().toLowerCase();
      const value = part
        .slice(colon + 1)
        .replace(/!\s*important\s*$/i, "")
        .trim();
      return name && value ? [[name, value] as [string, string]] : [];
    });
}

class Builder implements SvgSink {
  private readonly out: string[] = [];
  /** Per open element: its written name, or null when it (or an ancestor) is dropped. */
  private readonly stack: { name: string | null; empty: boolean }[] = [];

  constructor(
    private readonly prefix: string,
    private readonly rootExtra: string,
  ) {}

  result(): string {
    return this.out.join("");
  }

  private dropped(): boolean {
    return this.stack.length > 0 && this.stack.at(-1)?.name === null;
  }

  /** Writes `>` for a parent whose start tag is still open (it has content after all). */
  private fillParent(): void {
    const parent = this.stack.at(-1);
    if (parent?.empty) {
      this.out.push(">");
      parent.empty = false;
    }
  }

  private reference(value: string): string | null {
    if (value.trim().toLowerCase() === "none") return "none";
    const id = FRAGMENT_URL.exec(value.trim())?.[2];
    return id && ID.test(id) ? `url(#${this.prefix}${id})` : null;
  }

  /** The kept attributes of one element, in source order, values normalised. */
  private attributes(
    element: string,
    raw: readonly (readonly [string, string])[],
  ): Map<string, string> {
    const kept = new Map<string, string>();
    const set = (name: string, value: string) => {
      const lower = name.toLowerCase();
      if (PAINTS.has(lower)) return kept.set(lower, paint(value));
      if (REFERENCES.has(lower)) {
        const ref = this.reference(value);
        return ref === null ? kept.delete(lower) : kept.set(lower, ref);
      }
      const canonical = PRESENTATION.get(lower);
      if (canonical) kept.set(canonical, value.trim());
      return kept;
    };
    let style: string | undefined;
    for (const [qname, value] of raw) {
      const lower = qname.toLowerCase();
      if (lower === "style") style = value;
      else if (lower === "id") {
        if (ID.test(value)) kept.set("id", `${this.prefix}${value}`);
      } else if (lower === "href" || lower === "xlink:href") {
        const v = value.trim();
        if (element === "use" && v.startsWith("#") && ID.test(v.slice(1))) {
          kept.set("href", `#${this.prefix}${v.slice(1)}`);
        }
      } else if (GEOMETRY.has(lower)) {
        if (!(element === "svg" && this.stack.length === 0 && ROOT_DROPPED.has(lower))) {
          kept.set(GEOMETRY.get(lower) ?? lower, value);
        }
      } else set(lower, value);
    }
    for (const [name, value] of declarations(style ?? "")) set(name, value);
    return kept;
  }

  open(element: string, raw: readonly (readonly [string, string])[], selfClosing: boolean): void {
    const isRoot = this.stack.length === 0;
    // A nested <svg> is dropped with its content: the web's check wants one root (inline-logo.ts).
    const nested = element === "svg" && !isRoot;
    const name = this.dropped() || nested ? null : (ELEMENTS.get(element) ?? null);
    if (name === null) {
      if (!selfClosing) this.stack.push({ name: null, empty: true });
      return;
    }
    const attributes = this.attributes(element, raw);
    let text: string;
    if (isRoot) {
      const box = attributes.get("viewBox");
      const source = new Map(raw);
      const [w, h] = [length(source.get("width")), length(source.get("height"))];
      const fill = attributes.get("fill") ?? "currentColor";
      attributes.delete("viewBox");
      attributes.delete("fill");
      const head = new Map<string, string>([["xmlns", SVG_NS]]);
      if (box !== undefined) head.set("viewBox", box);
      else if (w !== null && h !== null) head.set("viewBox", `0 0 ${w} ${h}`);
      head.set("fill", fill);
      for (const [k, v] of attributes) head.set(k, v);
      text = [...head].map(([k, v]) => ` ${k}="${escape(v)}"`).join("");
    } else {
      this.fillParent();
      text = [...attributes].map(([k, v]) => ` ${k}="${escape(v)}"`).join("");
    }
    this.out.push(`<${name}${text}`);
    if (isRoot) {
      this.out.push(`>${this.rootExtra}`);
      if (selfClosing) this.out.push("</svg>");
      else this.stack.push({ name, empty: false });
    } else if (selfClosing) this.out.push("/>");
    else this.stack.push({ name, empty: true });
  }

  close(): void {
    const frame = this.stack.pop();
    if (!frame?.name) return;
    this.out.push(frame.empty ? "/>" : `</${frame.name}>`);
  }

  text(value: string): void {
    const parent = this.stack.at(-1);
    if (!parent?.name || !TEXT_ELEMENTS.has(parent.name)) return;
    this.fillParent();
    this.out.push(escape(value));
  }
}

function derive(bytes: Uint8Array, prefix: string, rootExtra: string): ThemedSvg {
  const builder = new Builder(prefix, rootExtra);
  const check = checkSvg(bytes, undefined, builder);
  return check.ok ? { ok: true, svg: builder.result() } : { ok: false, reason: check.reason };
}

/** The inline-safe logo: the only form of an upload the web may insert into the page. */
export function themedLogoSvg(bytes: Uint8Array): ThemedSvg {
  return derive(bytes, LOGO_ID_PREFIX, "");
}

/** The SVG favicon in currentColor with a fixed light/dark colour of its own. */
export function themedFaviconSvg(bytes: Uint8Array): ThemedSvg {
  return derive(bytes, FAVICON_ID_PREFIX, `<style>${FAVICON_SCHEME_STYLE}</style>`);
}
