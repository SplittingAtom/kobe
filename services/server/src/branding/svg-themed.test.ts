import { describe, expect, it } from "vitest";
import { GRADIENT_SVG, REFUSED_SVGS, REVIEW_REFUSED_SVGS } from "../testing/branding-fixtures.js";
import { checkSvg } from "./svg.js";
import { FAVICON_SCHEME_STYLE, themedFaviconSvg, themedLogoSvg } from "./svg-themed.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const bytes = (s: string) => new TextEncoder().encode(s);
const doc = (inner: string, root = 'viewBox="0 0 10 10"') =>
  bytes(`<svg ${NS} ${root}>${inner}</svg>`);

function inline(source: Uint8Array): string {
  const result = themedLogoSvg(source);
  if (!result.ok) throw new Error(result.reason);
  return result.svg;
}

/** Nothing that runs, styles the page or loads a URL may survive in the inline form. */
function expectInert(markup: string): void {
  expect(markup).not.toMatch(/<script|<style|<foreignObject|<image|<a[\s>]|<animate|<set[\s>]/i);
  expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
  expect(markup).not.toMatch(/\sstyle\s*=/i);
  expect(markup).not.toMatch(/\sclass\s*=/i);
  expect(markup).not.toMatch(/(?:xlink:)?href="(?!#kobe-logo-)/);
  expect(markup).not.toMatch(/url\(\s*['"]?(?!#kobe-logo-)/);
  // Every id is prefixed, so nothing can collide with the page's ids.
  for (const [, id] of markup.matchAll(/\sid="([^"]*)"/g)) expect(id).toMatch(/^kobe-logo-/);
}

describe("themedLogoSvg (KOBE-562, inline-safe variant)", () => {
  it("turns a plain monochrome logo into currentColor and keeps its geometry", () => {
    const markup = inline(doc('<path d="M0 0h10v10z" fill="#000000" fill-rule="evenodd"/>'));
    expect(markup).toBe(
      `<svg ${NS} viewBox="0 0 10 10" fill="currentColor">` +
        '<path d="M0 0h10v10z" fill="currentColor" fill-rule="evenodd"/></svg>',
    );
  });

  it("keeps fill and stroke none, and the root's own fill none", () => {
    const markup = inline(
      doc(
        '<circle cx="5" cy="5" r="4" fill="none" stroke="#123456" stroke-width="2"/>',
        `viewBox="0 0 10 10" fill="none"`,
      ),
    );
    expect(markup).toBe(
      `<svg ${NS} viewBox="0 0 10 10" fill="none">` +
        '<circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    );
    expect(inline(doc('<rect width="1" height="1" stroke="transparent"/>'))).toContain(
      'stroke="none"',
    );
  });

  it("drops <style> and style attributes, keeping their geometry as attributes (style injection)", () => {
    const markup = inline(
      doc(
        "<style>body { display: none } svg ~ * { visibility: hidden } .a { fill: red }</style>" +
          '<rect class="a" width="10" height="10" style="fill:#ff0000; stroke : rgb(0,0,255) !important;stroke-width:2;color:red;position:fixed;inset:0"/>',
      ),
    );
    expectInert(markup);
    expect(markup).not.toMatch(/body|visibility|position|inset|red/);
    expect(markup).toContain(
      '<rect width="10" height="10" fill="currentColor" stroke="currentColor" stroke-width="2"/>',
    );
  });

  it("lets a style declaration win over the attribute of the same name", () => {
    expect(
      inline(doc('<rect width="1" height="1" stroke-width="1" style="stroke-width:3"/>')),
    ).toContain('<rect width="1" height="1" stroke-width="3"/>');
  });

  it("prefixes ids and their url(#) and href references (id collision)", () => {
    const markup = inline(
      doc(
        '<defs><clipPath id="main"><rect width="5" height="5"/></clipPath>' +
          '<symbol id="app-root" viewBox="0 0 1 1"><path d="M0 0h1v1z"/></symbol></defs>' +
          '<g clip-path="url(#main)" mask="url( \'#m\' )"><use href="#app-root"/><use xlink:href="#app-root" x="1"/></g>' +
          '<mask id="m"><rect width="10" height="10" fill="#fff"/></mask>',
      ),
    );
    expectInert(markup);
    expect(markup).toContain('<clipPath id="kobe-logo-main">');
    expect(markup).toContain('<symbol id="kobe-logo-app-root" viewBox="0 0 1 1">');
    expect(markup).toContain('clip-path="url(#kobe-logo-main)" mask="url(#kobe-logo-m)"');
    expect(markup).toContain(
      '<use href="#kobe-logo-app-root"/><use href="#kobe-logo-app-root" x="1"/>',
    );
    expect(markup).toContain('<mask id="kobe-logo-m">');
  });

  it("drops ids and references it cannot prefix safely", () => {
    const markup = inline(doc('<g id="a b" clip-path="url(#a b)"><use href="#"/></g>'));
    expect(markup).toBe(`<svg ${NS} viewBox="0 0 10 10" fill="currentColor"><g><use/></g></svg>`);
  });

  it("replaces gradient and pattern paints with currentColor and drops the paint servers", () => {
    const markup = inline(
      doc(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient>' +
          '<pattern id="p" width="1" height="1"><rect width="1" height="1"/></pattern></defs>' +
          '<rect width="10" height="10" fill="url(#g)" stroke="url(#p) #000"/>',
      ),
    );
    expectInert(markup);
    expect(markup).not.toMatch(/Gradient|pattern|stop/);
    expect(markup).toContain(
      '<rect width="10" height="10" fill="currentColor" stroke="currentColor"/>',
    );
    expectInert(inline(GRADIENT_SVG));
  });

  it("refuses what §2.1 refuses before deriving anything (external href, handlers, script)", () => {
    for (const { bytes: source } of [...REFUSED_SVGS, ...REVIEW_REFUSED_SVGS]) {
      expect(themedLogoSvg(source).ok).toBe(false);
    }
    for (const hostile of [
      '<use href="https://evil.test/x.svg#a"/>',
      '<use xlink:href="data:image/svg+xml,&lt;svg/&gt;"/>',
      '<rect onload="alert(1)"/>',
      "<script>alert(1)</script>",
      "<foreignObject><div/></foreignObject>",
      '<rect style="fill:url(https://evil.test/x)"/>',
    ]) {
      expect(themedLogoSvg(doc(hostile)), hostile).toMatchObject({ ok: false });
    }
  });

  it("drops elements and attributes outside the allowlist, with their content", () => {
    const markup = inline(
      doc(
        '<a href="#top"><rect width="1" height="1"/></a>' +
          '<image href="#x" width="1" height="1"/><filter id="f"><feFlood flood-color="red"/></filter>' +
          '<animate attributeName="fill" to="red"/><set attributeName="display" to="none"/>' +
          "<title>Logo</title><desc>x</desc><metadata>m</metadata>" +
          '<rect width="1" height="1" class="c" data-x="1" tabindex="0" color="red" filter="url(#f)" marker-end="url(#f)" xml:space="preserve"/>',
      ),
    );
    expectInert(markup);
    expect(markup).toBe(
      `<svg ${NS} viewBox="0 0 10 10" fill="currentColor">` +
        '<g><rect width="1" height="1"/></g><rect width="1" height="1"/></svg>',
    );
  });

  it("drops a nested <svg> with its content, so the page gets one root", () => {
    expect(
      inline(doc('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg><circle r="1"/>')),
    ).toBe(`<svg ${NS} viewBox="0 0 10 10" fill="currentColor"><circle r="1"/></svg>`);
  });

  it("never turns a use href that is not a #fragment into a reference", () => {
    // §2.1 refuses it first; the builder also keeps href only in the #fragment form.
    expect(themedLogoSvg(doc('<use href="abc"/>')).ok).toBe(false);
    expect(inline(doc('<use href="#abc"/><use xlink:href=" #abc "/>'))).toContain(
      '<use href="#kobe-logo-abc"/><use href="#kobe-logo-abc"/>',
    );
  });

  it("keeps text inside text elements only, escaped", () => {
    const markup = inline(
      doc(
        'stray<text x="1" font-family="&quot;A&quot; &amp; B">A &amp; &lt;b&gt;<tspan>&#169;</tspan><![CDATA[<i>]]></text>',
      ),
    );
    expect(markup).toBe(
      `<svg ${NS} viewBox="0 0 10 10" fill="currentColor">` +
        '<text x="1" font-family="&quot;A&quot; &amp; B">A &amp; &lt;b&gt;<tspan>©</tspan>&lt;i&gt;</text></svg>',
    );
  });

  it("drops the root's size (the page sizes it) and derives a missing viewBox from it", () => {
    expect(
      inline(bytes(`<svg ${NS} width="120px" height="40"><rect width="1" height="1"/></svg>`)),
    ).toBe(
      `<svg ${NS} viewBox="0 0 120 40" fill="currentColor"><rect width="1" height="1"/></svg>`,
    );
    expect(inline(bytes(`<svg ${NS} width="10.5" height="3"/>`))).toBe(
      `<svg ${NS} viewBox="0 0 10.5 3" fill="currentColor"></svg>`,
    );
    expect(inline(bytes(`<svg ${NS} width="2em" height="1em"/>`))).toBe(
      `<svg ${NS} fill="currentColor"></svg>`,
    );
  });

  it("produces an SVG that the §2.1 reader accepts again", () => {
    expect(checkSvg(bytes(inline(GRADIENT_SVG))).ok).toBe(true);
  });
});

describe("themedFaviconSvg (KOBE-562)", () => {
  it("adds the self-contained scheme style and uses currentColor, prefixed for the favicon", () => {
    const result = themedFaviconSvg(
      doc('<path id="p" d="M0 0h1v1z" fill="#2449c7"/><use href="#p"/>'),
    );
    expect(result).toEqual({
      ok: true,
      svg:
        `<svg ${NS} viewBox="0 0 10 10" fill="currentColor"><style>${FAVICON_SCHEME_STYLE}</style>` +
        '<path id="kobe-favicon-p" d="M0 0h1v1z" fill="currentColor"/><use href="#kobe-favicon-p"/></svg>',
    });
    expect(FAVICON_SCHEME_STYLE).toBe(
      "svg{color:#1b1b1f}@media (prefers-color-scheme: dark){svg{color:#ffffff}}",
    );
    expect(checkSvg(bytes(result.ok ? result.svg : "")).ok).toBe(true);
  });

  it("refuses what §2.1 refuses", () => {
    expect(themedFaviconSvg(doc('<rect onclick="x()"/>')).ok).toBe(false);
  });
});
