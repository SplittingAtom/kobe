import { describe, expect, it } from "vitest";
import {
  GRADIENT_SVG,
  REFUSED_SVGS,
  REVIEW_REFUSED_SVGS,
  svg,
} from "../testing/branding-fixtures.js";
import { checkSvg } from "./svg.js";

const text = (s: string) => new TextEncoder().encode(s);

describe("checkSvg (TH8)", () => {
  it("accepts a clean SVG with fragments, gradients, comments and CDATA", () => {
    expect(checkSvg(svg())).toEqual({ ok: true, size: { width: 10, height: 10 } });
    expect(
      checkSvg(
        svg(
          '<!-- logo --><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
            '<rect fill="url(#g)" width="10" height="10"/><use xlink:href="#g"/><a href=" #top"><text>A &amp; B &#169;</text></a>' +
            "<style><![CDATA[rect { fill: #123456 }]]></style>",
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(checkSvg(text('﻿  <svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({
      ok: true,
      size: null,
    });
  });

  it("reports the box from width/height, else the viewBox, as whole pixels", () => {
    const root = (attrs: string) =>
      checkSvg(text(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}/>`));
    expect(root('width="120" height="40" viewBox="0 0 12 4"')).toMatchObject({
      size: { width: 120, height: 40 },
    });
    expect(root('width="120px" height="40px"')).toMatchObject({ size: { width: 120, height: 40 } });
    expect(root('width="100%" height="100%" viewBox="0 0 300 100"')).toMatchObject({
      size: { width: 300, height: 100 },
    });
    expect(root('viewBox="0,0,1.5,1"')).toMatchObject({ size: { width: 1000, height: 667 } });
    expect(root('viewBox="0 0 10000 5000"')).toMatchObject({ size: { width: 1000, height: 500 } });
    expect(root('width="2em" height="1em"')).toMatchObject({ size: null });
    expect(root('viewBox="0 0 0 10"')).toMatchObject({ size: null });
  });

  it("accepts url(#id) references in style attributes and <style> (Inkscape exports)", () => {
    expect(checkSvg(GRADIENT_SVG)).toMatchObject({ ok: true });
  });

  it.each(REVIEW_REFUSED_SVGS)(
    "refuses $name with the reason (security review)",
    ({ bytes, reason }) => {
      const result = checkSvg(bytes);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.reason).toMatch(reason);
    },
  );

  it.each(["embed", "object", "base", "link"])("refuses a <%s> element", (element) => {
    expect(checkSvg(svg(`<${element}/>`))).toMatchObject({
      ok: false,
      reason: new RegExp(`<${element}>`),
    });
  });

  it("refuses action and formaction attributes", () => {
    for (const attr of ["action", "formaction"]) {
      expect(checkSvg(svg(`<g ${attr}="https://evil.test"/>`)).ok, attr).toBe(false);
    }
  });

  it("allows xml: attributes and the xlink namespace", () => {
    expect(checkSvg(svg('<g xml:space="preserve"><use xlink:href="#g"/></g>'))).toMatchObject({
      ok: true,
    });
  });

  it.each(REFUSED_SVGS)("refuses $name with the reason", ({ bytes, reason }) => {
    const result = checkSvg(bytes);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(reason);
  });

  it("refuses broken XML and non-UTF-8 bytes", () => {
    for (const bad of [
      "<svg>",
      "<svg></svg><svg></svg>",
      '<svg a="1" a="2"/>',
      "<svg a=1/>",
      "<svg>&</svg>",
      "x<svg/>",
      "<svg/>trailing",
      "<svg>&#0;</svg>",
      '<svg a="<"/>',
    ]) {
      expect(checkSvg(text(bad)).ok, bad).toBe(false);
    }
    expect(checkSvg(Uint8Array.from([0x3c, 0x73, 0xff, 0xfe])).ok).toBe(false);
  });
});
