/**
 * The SVG rule (TH8): an SVG is refused, with the reason, rather than sanitised. A small strict XML
 * reader (no dependency): anything it cannot read is refused as not well-formed, so nothing it
 * skips can reach the browser. Refused: a DOCTYPE or entity declaration (external entities),
 * processing instructions other than the XML declaration (xml-stylesheet), `<script>`,
 * `<foreignObject>`, any `on*` attribute, an `href`/`xlink:href` that is not a `#fragment`
 * (also as an animation target), `url(` / `@import` / CSS escapes in a `style` attribute or
 * `<style>`, and `url(` other than `url(#fragment)` in any other attribute.
 */

export type SvgCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*/;
const PREDEFINED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
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

function checkCss(css: string, where: string): void {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").toLowerCase();
  if (flat.includes("\\")) refuse(`${where} uses CSS escapes.`);
  if (/url\s*\(/.test(flat)) refuse(`${where} uses url(.`);
  if (flat.includes("@import")) refuse(`${where} uses @import.`);
}

function checkAttribute(element: string, qname: string, value: string): void {
  const name = localName(qname);
  if (name.startsWith("on")) refuse(`the attribute ${qname} is an event handler.`);
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
  const urls = value.toLowerCase().match(/url\s*\(\s*['"]?([^)'"]*)/g) ?? [];
  for (const u of urls) {
    if (!/url\s*\(\s*['"]?#/.test(u)) refuse(`the attribute ${qname} uses url( outside the image.`);
  }
  if (value.includes("\\") && value.toLowerCase().includes("url")) {
    refuse(`the attribute ${qname} uses CSS escapes.`);
  }
}

interface Reader {
  readonly src: string;
  pos: number;
}

function readAttributes(r: Reader, element: string): { selfClosing: boolean } {
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
    checkAttribute(element, name, decodeEntities(raw));
  }
}

function skipPast(r: Reader, terminator: string, what: string): string {
  const end = r.src.indexOf(terminator, r.pos);
  if (end < 0) refuse(`it is not well-formed XML (an unterminated ${what}).`);
  const body = r.src.slice(r.pos, end);
  r.pos = end + terminator.length;
  return body;
}

function walk(src: string): void {
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
      const element = localName(qname);
      if (stack.length === 0) {
        if (rootSeen) refuse("it is not well-formed XML (more than one root element).");
        if (element !== "svg") refuse("its root element is not <svg>.");
        rootSeen = true;
      }
      if (element === "script") refuse("it contains a <script> element.");
      if (element === "foreignobject") refuse("it contains a <foreignObject> element.");
      const { selfClosing } = readAttributes(r, element);
      if (!selfClosing) {
        stack.push(element);
        if (stack.length > MAX_DEPTH) refuse("it nests elements too deeply.");
      }
    }
  }
  if (!rootSeen) refuse("it has no <svg> root element.");
  if (stack.length > 0) refuse("it is not well-formed XML (unclosed tags).");
}

/** Checks SVG bytes against the TH8 rule. */
export function checkSvg(bytes: Uint8Array): SvgCheck {
  let src: string;
  try {
    src = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, reason: "it is not UTF-8 text." };
  }
  src = src.replace(/^\s+/, "");
  try {
    walk(src);
    return { ok: true };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message };
    throw err;
  }
}
