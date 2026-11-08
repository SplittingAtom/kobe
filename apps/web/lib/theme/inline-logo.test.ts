import { describe, expect, it } from "vitest";
import { inlineSafeMarkup, sizedLogoMarkup } from "./inline-logo";

/** KOBE-562: the web inserts only the server's inline-safe variant, and checks it again. */
const NS = 'xmlns="http://www.w3.org/2000/svg"';
const SAFE =
  `<svg ${NS} viewBox="0 0 10 10" fill="currentColor"><defs><clipPath id="kobe-logo-c">` +
  '<rect width="5" height="5"/></clipPath></defs><g clip-path="url(#kobe-logo-c)">' +
  '<use href="#kobe-logo-p"/><text>A &amp; B</text></g></svg>';

describe("inlineSafeMarkup", () => {
  it("accepts the server's variant", () => {
    expect(inlineSafeMarkup(SAFE)).toBe(SAFE);
    expect(inlineSafeMarkup(`  ${SAFE}\n`)).toBe(SAFE);
  });

  it.each([
    ["not an svg", "<div>x</div>"],
    ["another namespace", '<svg xmlns="http://www.w3.org/1999/xhtml"></svg>'],
    ["trailing content", `${SAFE}<img src=x onerror=alert(1)>`],
    ["a script", `<svg ${NS}><script>alert(1)</script></svg>`],
    ["a style element", `<svg ${NS}><style>body{display:none}</style></svg>`],
    ["a style attribute", `<svg ${NS}><rect style="position:fixed"/></svg>`],
    ["an event handler", `<svg ${NS}><rect onload="x()"/></svg>`],
    ["a handler after a slash", `<svg ${NS}><rect/onload="x()"/></svg>`],
    ["foreignObject", `<svg ${NS}><foreignObject/></svg>`],
    ["an external href", `<svg ${NS}><use href="https://evil.test/a.svg#x"/></svg>`],
    ["an unprefixed href", `<svg ${NS}><use href="#app"/></svg>`],
    ["an unprefixed url()", `<svg ${NS}><g clip-path="url(#main)"/></svg>`],
    ["a javascript: url", `<svg ${NS}><a href="javascript:alert(1)"/></svg>`],
    ["an unprefixed id", `<svg ${NS}><g id="main"/></svg>`],
    ["an image", `<svg ${NS}><image/></svg>`],
    ["too large", `<svg ${NS}>${"<g/>".repeat(300_000)}</svg>`],
  ])("refuses %s", (_name, markup) => {
    expect(inlineSafeMarkup(markup)).toBeNull();
  });
});

describe("sizedLogoMarkup", () => {
  it("adds the size and hides the drawing from assistive technology", () => {
    expect(sizedLogoMarkup(SAFE, 48, 24)).toMatch(
      /^<svg width="48" height="24" focusable="false" aria-hidden="true" xmlns=/,
    );
    expect(sizedLogoMarkup(SAFE, undefined, 24)).toMatch(
      /^<svg height="24" focusable="false" aria-hidden="true" xmlns=/,
    );
  });

  it("writes only whole positive numbers", () => {
    expect(sizedLogoMarkup(SAFE, Number.NaN, -3)).toMatch(
      /^<svg focusable="false" aria-hidden="true" xmlns=/,
    );
    expect(sizedLogoMarkup(SAFE, 12.6, 24)).toMatch(/^<svg width="13" height="24" /);
  });
});
