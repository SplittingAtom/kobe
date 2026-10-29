import { crc32 } from "node:zlib";

/** Tiny generated branding files (KOBE-499): headers only, enough for the server's checks. */

const u32be = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const u16be = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u16le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u24le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const u32le = (n: number): number[] => [...u16le(n & 0xffff), ...u16le(n >>> 16)];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function chunk(type: string, data: number[]): number[] {
  const body = [...ascii(type), ...data];
  return [...u32be(data.length), ...body, ...u32be(crc32(Uint8Array.from(body)))];
}

export function png(width = 2, height = 2): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    ...chunk("IDAT", [0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),
    ...chunk("IEND", []),
  ]);
}

export function jpeg(width = 2, height = 2): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...u16be(16),
    ...ascii("JFIF"),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xc0,
    ...u16be(11),
    8,
    ...u16be(height),
    ...u16be(width),
    1,
    1,
    0x11,
    0,
    0xff,
    0xd9,
  ]);
}

function riff(chunkType: string, payload: number[]): Uint8Array {
  const body = [...ascii("WEBP"), ...ascii(chunkType), ...u32le(payload.length), ...payload];
  return Uint8Array.from([...ascii("RIFF"), ...u32le(body.length), ...body]);
}

/** Extended WebP (VP8X): canvas width/height minus one, 24-bit little-endian. */
export function webp(width = 2, height = 2): Uint8Array {
  return riff("VP8X", [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
}

/** Lossy WebP (VP8 key frame header). */
export function webpLossy(width = 2, height = 2): Uint8Array {
  return riff("VP8 ", [
    0x30,
    0x01,
    0x00,
    0x9d,
    0x01,
    0x2a,
    ...u16le(width),
    ...u16le(height),
    0,
    0,
  ]);
}

/** Lossless WebP (VP8L): 14-bit width-1 and height-1. */
export function webpLossless(width = 2, height = 2): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return riff("VP8L", [0x2f, ...u32le(bits), 0, 0, 0]);
}

/** A BMP as stored in an ICO: BITMAPINFOHEADER (height doubled for the AND mask), no pixels. */
export function bmpDib(width = 1, height = 1): Uint8Array {
  return Uint8Array.from([
    ...u32le(40),
    ...u32le(width),
    ...u32le(height * 2),
    ...u16le(1),
    ...u16le(32),
    ...new Array<number>(24).fill(0),
  ]);
}

/** An ICO with one entry holding `image` (a PNG by default); `offset`/`size` override the entry. */
export function ico(
  image: Uint8Array = png(1, 1),
  entry: { offset?: number; size?: number } = {},
): Uint8Array {
  return Uint8Array.from([
    0,
    0,
    1,
    0,
    ...u16le(1),
    1,
    1,
    0,
    0,
    ...u16le(1),
    ...u16le(32),
    ...u32le(entry.size ?? image.length),
    ...u32le(entry.offset ?? 22),
    ...image,
  ]);
}

export const svg = (inner = '<rect width="10" height="10" fill="#2449c7"/>'): Uint8Array =>
  new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">${inner}</svg>`,
  );

/** An Inkscape-style export: gradient, clip path and marker referenced by url(#id) in styles. */
export const GRADIENT_SVG = svg(
  '<defs><linearGradient id="g"><stop offset="0" style="stop-color:#2449c7"/></linearGradient>' +
    '<clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
    "<style>.a { fill: url( '#g' ); clip-path: url(#c) }</style>" +
    '<rect class="a" style="fill:url(#g);stroke:url(&quot;#g&quot;)" width="10" height="10"/>',
);

const doc = (s: string) => new TextEncoder().encode(s);
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">';

/** Security review (KOBE-499): each bypass attempt with a word its reason must contain. */
export const REVIEW_REFUSED_SVGS: readonly {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly reason: RegExp;
}[] = [
  {
    name: "svg:script",
    bytes: doc(
      `${SVG_OPEN}<svg:script xmlns:svg="http://www.w3.org/2000/svg">x</svg:script></svg>`,
    ),
    reason: /prefixed element/,
  },
  {
    name: "XLINK:HREF casing",
    bytes: svg('<use XLINK:HREF="https://evil.test/#x"/>'),
    reason: /another namespace/,
  },
  { name: "OnLoad casing", bytes: svg('<rect OnLoad="alert(1)"/>'), reason: /event handler/ },
  {
    name: "use href data:",
    bytes: svg('<use href="data:image/svg+xml,&lt;svg/&gt;"/>'),
    reason: /#fragment/,
  },
  {
    name: "image href https:",
    bytes: svg('<image href="https://evil.test/x.png"/>'),
    reason: /#fragment/,
  },
  { name: "a href", bytes: svg('<a href="https://evil.test/"><rect/></a>'), reason: /#fragment/ },
  {
    name: "comment-split @import",
    bytes: svg("<style>@im/**/port 'https://evil.test/x.css';</style>"),
    reason: /@import/,
  },
  { name: "<style>@import", bytes: svg("<style>@import url(#x);</style>"), reason: /@import/ },
  {
    name: "CDATA-wrapped script",
    bytes: svg("<script><![CDATA[alert(1)]]></script>"),
    reason: /<script>/,
  },
  {
    name: "XHTML namespace root with meta refresh",
    bytes: doc(
      '<svg xmlns="http://www.w3.org/1999/xhtml"><meta http-equiv="refresh" content="0;url=https://evil.test"/></svg>',
    ),
    reason: /namespace/,
  },
  { name: "meta element", bytes: svg('<meta http-equiv="refresh"/>'), reason: /<meta>/ },
  { name: "iframe element", bytes: svg("<iframe/>"), reason: /<iframe>/ },
  { name: "form element", bytes: svg("<form/>"), reason: /<form>/ },
  { name: "handler element", bytes: svg("<handler/>"), reason: /<handler>/ },
  { name: "content attribute", bytes: svg('<g content="x"/>'), reason: /content is not allowed/ },
  { name: "src attribute", bytes: svg('<g src="x"/>'), reason: /src is not allowed/ },
  { name: "other namespace declaration", bytes: svg('<g xmlns:x="urn:evil"/>'), reason: /xmlns:x/ },
  {
    name: "default namespace switch",
    bytes: svg('<g xmlns="http://www.w3.org/1999/xhtml"/>'),
    reason: /only SVG/,
  },
  { name: "no namespace", bytes: doc("<svg><rect/></svg>"), reason: /SVG namespace/ },
  {
    name: "CSS escape in a presentation attribute",
    bytes: svg('<rect fill="\\75 rl(https://evil.test/x)"/>'),
    reason: /backslash/,
  },
  {
    name: "CSS escape in <style>",
    bytes: svg("<style>rect{fill:\\75 rl(x)}</style>"),
    reason: /backslash/,
  },
  {
    name: "image-set(",
    bytes: svg("<style>rect{fill:image-set('https://evil.test/x' 1x)}</style>"),
    reason: /image-set/,
  },
  {
    name: "src(",
    bytes: svg('<rect style="fill:src(&quot;https://evil.test&quot;)"/>'),
    reason: /src\(/,
  },
];

/** Each refused SVG with a word its reason must contain. */
export const REFUSED_SVGS: readonly {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly reason: RegExp;
}[] = [
  { name: "script", bytes: svg("<script>alert(1)</script>"), reason: /<script>/ },
  { name: "onload", bytes: svg('<rect onload="alert(1)"/>'), reason: /event handler/ },
  {
    name: "onclick on root",
    bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onClick="x()"/>'),
    reason: /event handler/,
  },
  {
    name: "foreignObject",
    bytes: svg("<foreignObject><div/></foreignObject>"),
    reason: /foreignObject/,
  },
  {
    name: "external href",
    bytes: svg('<a href="https://evil.test/"><rect/></a>'),
    reason: /#fragment/,
  },
  {
    name: "external xlink:href",
    bytes: svg('<image xlink:href="data:image/png;base64,AA"/>'),
    reason: /#fragment/,
  },
  {
    name: "url(data:) in a style attribute",
    bytes: svg('<rect style="fill:url(data:image/png;base64,AA)"/>'),
    reason: /only url\(#id\)/,
  },
  {
    name: "url(https:) in a style attribute",
    bytes: svg("<rect style=\"fill:url('https://evil.test/x.svg#g')\"/>"),
    reason: /only url\(#id\)/,
  },
  {
    name: "url( in <style>",
    bytes: svg("<style>rect{background:url(https://evil.test/x)}</style>"),
    reason: /url\(/,
  },
  {
    name: "@import in <style>",
    bytes: svg("<style><![CDATA[@import 'https://evil.test/x.css';]]></style>"),
    reason: /@import/,
  },
  {
    name: "external url( in an attribute",
    bytes: svg('<rect fill="url(https://evil.test/#g)"/>'),
    reason: /url\(/,
  },
  {
    name: "DOCTYPE with an external entity",
    bytes: new TextEncoder().encode(
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    ),
    reason: /DOCTYPE/,
  },
  { name: "entity reference", bytes: svg("<text>&x;</text>"), reason: /entity/ },
  {
    name: "xml-stylesheet",
    bytes: new TextEncoder().encode(
      '<?xml-stylesheet href="https://evil.test/x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    ),
    reason: /processing instruction/,
  },
  {
    name: "encoded javascript href",
    bytes: svg('<a href="&#x6a;avascript:alert(1)"><rect/></a>'),
    reason: /#fragment/,
  },
  {
    name: "animated href",
    bytes: svg('<a href="#a"><set attributeName="href" to="javascript:alert(1)"/></a>'),
    reason: /animates a link/,
  },
  { name: "not well-formed", bytes: svg("<g><rect></g>"), reason: /well-formed/ },
  {
    name: "not svg root",
    bytes: new TextEncoder().encode("<html><body/></html>"),
    reason: /root element/,
  },
];
