import { describe, expect, it } from "vitest";
import { REFUSED_SVGS, svg } from "../testing/branding-fixtures.js";
import { checkSvg } from "./svg.js";

const text = (s: string) => new TextEncoder().encode(s);

describe("checkSvg (TH8)", () => {
  it("accepts a clean SVG with fragments, gradients, comments and CDATA", () => {
    expect(checkSvg(svg())).toEqual({ ok: true });
    expect(
      checkSvg(
        svg(
          '<!-- logo --><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
            '<rect fill="url(#g)" width="10" height="10"/><use xlink:href="#g"/><a href=" #top"><text>A &amp; B &#169;</text></a>' +
            "<style><![CDATA[rect { fill: #123456 }]]></style>",
        ),
      ),
    ).toEqual({ ok: true });
    expect(checkSvg(text('﻿  <svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({ ok: true });
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
