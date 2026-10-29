/**
 * The SVG rule (TH8): an SVG is refused, with the reason, rather than sanitised. A small strict XML
 * reader (no dependency): anything it cannot read is refused as not well-formed, so nothing it
 * skips can reach the browser. Refused: a DOCTYPE or entity declaration (external entities),
 * processing instructions other than the XML declaration (xml-stylesheet), `<script>`,
 * `<foreignObject>`, any `on*` attribute, an `href`/`xlink:href` that is not a `#fragment`
 * (also as an animation target), `@import` and CSS escapes in a `style` attribute or `<style>`,
 * and anywhere a `url(` other than `url(#fragment)` (gradients, clip paths, masks, markers).
 * Namespaces: the root is in the SVG namespace; the only other namespace is xlink (plus the
 * reserved `xml:` attributes); any other declaration, prefixed element or attribute is refused, as
 * are HTML-ish elements (`meta`, `iframe`, `form`, ...), the attributes `content`, `action`,
 * `src`, `formaction`, any backslash (CSS escapes) and `image-set(` / `src(`.
 */

/** An accepted SVG's box (from the root's width/height, else its viewBox), when it has one. */
export interface SvgSize {
  readonly width: number;
  readonly height: number;
}

export type SvgCheck =
  | { readonly ok: true; readonly size: SvgSize | null }
  | { readonly ok: false; readonly reason: string };

const NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*/;
const PREDEFINED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const ATTRIBUTE_PREFIXES = new Set(["xlink", "xml"]);
const REFUSED_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "meta",
  "iframe",
  "form",
  "embed",
  "object",
  "base",
  "link",
  "handler",
]);
const REFUSED_ATTRIBUTES = new Set(["content", "action", "src", "formaction"]);
const ANIMATION = new Set(["animate", "set", "animatemotion", "animatetransform", "discard"]);
const MAX_DEPTH = 256;

class Refused extends Error {}

const refuse = (reason: string): never => {
  throw new Refused(reason);
};

/** Resolves character and the five predefined entity references; any other one is refused. */
function decodeEntities(text: string): string {
  return text.replace(/&([^;&\s]*);?/g, (whole, ref: string) => {
    if (!whole.endsWith(";")) return refuse("it is not well-formed XML (a bare &).");
    if (ref in PREDEFINED) return PREDEFINED[ref] ?? "";
    const num = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(ref);
    if (num) {
      const code = Number.parseInt(num[1] ?? num[2] ?? "", num[1] ? 16 : 10);
      if (code > 0x10ffff || code === 0)
        return refuse("it is not well-formed XML (a bad character reference).");
      return String.fromCodePoint(code);
    }
    return refuse("it uses an entity reference (external entities are not allowed).");
  });
}

const localName = (qname: string): string => (qname.split(":").pop() ?? qname).toLowerCase();

/** Every `url(` must reference a fragment of the image itself (`url(#id)`: gradients, masks). */
function checkUrls(text: string, where: string): void {
  for (const m of text.toLowerCase().matchAll(/url\s*\(\s*['"]?\s*(.?)/g)) {
    if (m[1] !== "#") {
      refuse(`${where} uses url( outside the image: only url(#id) references are allowed.`);
    }
  }
}

/** CSS escapes, and the functions that load a URL without `url(`. */
function checkLoaders(text: string, where: string): void {
  if (text.includes("\\")) refuse(`${where} uses a backslash (CSS escapes are not allowed).`);
  if (/(^|[^a-z0-9_-])(image-set|src)\s*\(/i.test(text)) {
    refuse(`${where} uses image-set( or src( (they load URLs).`);
  }
  checkUrls(text, where);
}

function checkCss(css: string, where: string): void {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  checkLoaders(flat, where);
  if (flat.toLowerCase().includes("@import")) refuse(`${where} uses @import.`);
}

function checkNamespace(qname: string, value: string): void {
  if (qname === "xmlns") {
    if (value !== SVG_NS)
      refuse(`it declares the namespace ${value || "(empty)"}: only SVG is allowed.`);
    return;
  }
  if (qname.startsWith("xmlns:")) {
    if (qname !== "xmlns:xlink" || value !== XLINK_NS) {
      refuse(`it declares the namespace ${qname}: only SVG and xlink are allowed.`);
    }
    return;
  }
  const prefix = qname.includes(":") ? qname.split(":")[0] : undefined;
  if (prefix !== undefined && !ATTRIBUTE_PREFIXES.has(prefix)) {
    refuse(`the attribute ${qname} is in another namespace (only xlink: and xml: are allowed).`);
  }
}

function checkAttribute(element: string, qname: string, value: string): void {
  checkNamespace(qname, value);
  const name = localName(qname);
  if (name.startsWith("on")) refuse(`the attribute ${qname} is an event handler.`);
  if (REFUSED_ATTRIBUTES.has(name)) refuse(`the attribute ${qname} is not allowed.`);
  if (name === "href" && !value.trim().startsWith("#")) {
    refuse(`<${element}> links outside the image (${qname} must be a #fragment).`);
  }
  if (name === "style") {
    checkCss(value, `the style attribute of <${element}>`);
    return;
  }
  if (ANIMATION.has(element) && name === "attributename" && /href/i.test(value)) {
    refuse(`<${element}> animates a link.`);
  }
  checkLoaders(value, `the attribute ${qname}`);
}

interface Reader {
  readonly src: string;
  pos: number;
}

function readAttributes(
  r: Reader,
  element: string,
  attributes?: Map<string, string>,
): { selfClosing: boolean } {
  const seen = new Set<string>();
  for (;;) {
    const ws = /^\s*/.exec(r.src.slice(r.pos))?.[0].length ?? 0;
    r.pos += ws;
    if (r.src.startsWith("/>", r.pos)) {
      r.pos += 2;
      return { selfClosing: true };
    }
    if (r.src.startsWith(">", r.pos)) {
      r.pos += 1;
      return { selfClosing: false };
    }
    if (ws === 0) refuse("it is not well-formed XML (attributes).");
    const name = NAME.exec(r.src.slice(r.pos))?.[0];
    if (!name) return refuse("it is not well-formed XML (an attribute name).");
    r.pos += name.length;
    const eq = /^\s*=\s*/.exec(r.src.slice(r.pos))?.[0];
    if (!eq) return refuse("it is not well-formed XML (an attribute without a value).");
    r.pos += eq.length;
    const quote = r.src[r.pos];
    if (quote !== '"' && quote !== "'")
      return refuse("it is not well-formed XML (an unquoted attribute).");
    const end = r.src.indexOf(quote, r.pos + 1);
    if (end < 0) return refuse("it is not well-formed XML (an unterminated attribute).");
    const raw = r.src.slice(r.pos + 1, end);
    if (raw.includes("<")) refuse("it is not well-formed XML (< in an attribute).");
    r.pos = end + 1;
    if (seen.has(name)) refuse(`it is not well-formed XML (${name} appears twice).`);
    seen.add(name);
    const value = decodeEntities(raw);
    checkAttribute(element, name, value);
    attributes?.set(name, value);
  }
}

function skipPast(r: Reader, terminator: string, what: string): string {
  const end = r.src.indexOf(terminator, r.pos);
  if (end < 0) refuse(`it is not well-formed XML (an unterminated ${what}).`);
  const body = r.src.slice(r.pos, end);
  r.pos = end + terminator.length;
  return body;
}

function walk(src: string): Map<string, string> {
  const rootAttributes = new Map<string, string>();
  const r: Reader = { src, pos: 0 };
  const stack: string[] = [];
  let rootSeen = false;
  let styleText = "";
  if (src.startsWith("<?xml") && /^<\?xml[\s?]/.test(src)) {
    r.pos = 2;
    skipPast(r, "?>", "XML declaration");
  }
  while (r.pos < src.length) {
    const lt = src.indexOf("<", r.pos);
    const text = src.slice(r.pos, lt < 0 ? src.length : lt);
    if (stack.length === 0 && text.trim() !== "")
      refuse("it is not well-formed XML (text outside the root).");
    const decoded = decodeEntities(text);
    if (stack.at(-1) === "style") styleText += decoded;
    if (lt < 0) break;
    r.pos = lt;
    if (src.startsWith("<!--", r.pos)) {
      r.pos += 4;
      skipPast(r, "-->", "comment");
    } else if (src.startsWith("<![CDATA[", r.pos)) {
      if (stack.length === 0) refuse("it is not well-formed XML (CDATA outside the root).");
      r.pos += 9;
      const data = skipPast(r, "]]>", "CDATA section");
      if (stack.at(-1) === "style") styleText += data;
    } else if (src.startsWith("<!", r.pos)) {
      refuse("it has a DOCTYPE or an entity declaration (not allowed).");
    } else if (src.startsWith("<?", r.pos)) {
      refuse("it has a processing instruction (e.g. xml-stylesheet; not allowed).");
    } else if (src.startsWith("</", r.pos)) {
      r.pos += 2;
      const name = NAME.exec(src.slice(r.pos))?.[0];
      if (!name) return refuse("it is not well-formed XML (a closing tag).");
      r.pos += name.length;
      const close = /^\s*>/.exec(src.slice(r.pos))?.[0];
      if (!close) return refuse("it is not well-formed XML (a closing tag).");
      r.pos += close.length;
      const open = stack.pop();
      if (open === undefined || open !== localName(name)) {
        refuse("it is not well-formed XML (mismatched tags).");
      }
      if (open === "style") {
        checkCss(styleText, "a <style> element");
        styleText = "";
      }
    } else {
      r.pos += 1;
      const qname = NAME.exec(src.slice(r.pos))?.[0];
      if (!qname) return refuse("it is not well-formed XML (a tag).");
      r.pos += qname.length;
      if (qname.includes(":"))
        refuse(`it has the prefixed element <${qname}> (only SVG elements are allowed).`);
      const element = localName(qname);
      if (stack.length === 0) {
        if (rootSeen) refuse("it is not well-formed XML (more than one root element).");
        if (element !== "svg") refuse("its root element is not <svg>.");
        rootSeen = true;
      }
      if (element === "script") refuse("it contains a <script> element.");
      if (element === "foreignobject") refuse("it contains a <foreignObject> element.");
      if (REFUSED_ELEMENTS.has(element)) refuse(`it contains a <${qname}> element (not allowed).`);
      const isRoot = stack.length === 0;
      const { selfClosing } = readAttributes(r, element, isRoot ? rootAttributes : undefined);
      if (isRoot && rootAttributes.get("xmlns") !== SVG_NS) {
        refuse(`its root element is not in the SVG namespace (xmlns="${SVG_NS}").`);
      }
      if (!selfClosing) {
        stack.push(element);
        if (stack.length > MAX_DEPTH) refuse("it nests elements too deeply.");
      }
    }
  }
  if (!rootSeen) refuse("it has no <svg> root element.");
  if (stack.length > 0) refuse("it is not well-formed XML (unclosed tags).");
  return rootAttributes;
}

/** A length in user units or px (`120`, `120.5px`); null for %, em and the like. */
function length(value: string | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)(?:px)?\s*$/.exec(value ?? "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Whole-pixel sides for the page's layout box: exact when whole and ≤ max, else the aspect. */
function wholeSize(width: number, height: number, max: number): SvgSize {
  if (Number.isInteger(width) && Number.isInteger(height) && Math.max(width, height) <= max) {
    return { width, height };
  }
  const scale = Math.min(max, 1000) / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The root's box: width/height attributes, else the viewBox's size. */
export function svgSize(attributes: ReadonlyMap<string, string>, max: number): SvgSize | null {
  const w = length(attributes.get("width"));
  const h = length(attributes.get("height"));
  if (w !== null && h !== null) return wholeSize(w, h, max);
  const box = (attributes.get("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [, , vw, vh] = box;
  if (
    box.length === 4 &&
    box.every(Number.isFinite) &&
    vw !== undefined &&
    vh !== undefined &&
    vw > 0 &&
    vh > 0
  ) {
    return wholeSize(vw, vh, max);
  }
  return null;
}

/** Checks SVG bytes against the TH8 rule; `maxSide` bounds the reported size. */
export function checkSvg(bytes: Uint8Array, maxSide = 4096): SvgCheck {
  let src: string;
  try {
    src = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, reason: "it is not UTF-8 text." };
  }
  src = src.replace(/^\s+/, "");
  try {
    return { ok: true, size: svgSize(walk(src), maxSide) };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message };
    throw err;
  }
}
