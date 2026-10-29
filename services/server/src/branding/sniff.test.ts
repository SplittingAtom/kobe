import { describe, expect, it } from "vitest";
import {
  ico,
  jpeg,
  png,
  svg,
  webp,
  webpLossless,
  webpLossy,
} from "../testing/branding-fixtures.js";
import { detectType, inspectImage } from "./sniff.js";

describe("detectType", () => {
  it("reads the type from the magic bytes", () => {
    expect(detectType(png())).toBe("image/png");
    expect(detectType(jpeg())).toBe("image/jpeg");
    expect(detectType(webp())).toBe("image/webp");
    expect(detectType(ico())).toBe("image/x-icon");
    expect(detectType(svg())).toBe("image/svg+xml");
    expect(detectType(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(detectType(new Uint8Array())).toBeNull();
  });
});

describe("inspectImage", () => {
  it("parses raster dimensions", () => {
    expect(inspectImage("logo", png(300, 120))).toEqual({
      ok: true,
      contentType: "image/png",
      width: 300,
      height: 120,
    });
    expect(inspectImage("logo", jpeg(64, 32))).toMatchObject({ width: 64, height: 32 });
    expect(inspectImage("logo", webp(4096, 10))).toMatchObject({ width: 4096, height: 10 });
    expect(inspectImage("logo", webpLossy(17, 9))).toMatchObject({ width: 17, height: 9 });
    expect(inspectImage("logo", webpLossless(33, 5))).toMatchObject({ width: 33, height: 5 });
    expect(inspectImage("favicon", ico())).toEqual({
      ok: true,
      contentType: "image/x-icon",
      width: null,
      height: null,
    });
    expect(inspectImage("favicon", svg())).toMatchObject({
      ok: true,
      contentType: "image/svg+xml",
    });
  });

  it("refuses types not allowed for the kind", () => {
    expect(inspectImage("favicon", jpeg())).toMatchObject({
      status: 415,
      code: "unsupported_type",
    });
    expect(inspectImage("favicon", webp())).toMatchObject({ status: 415 });
    expect(inspectImage("logo", ico())).toMatchObject({
      status: 415,
      message: /ICO is not accepted/,
    });
    expect(inspectImage("logo", new TextEncoder().encode("GIF89a...."))).toMatchObject({
      status: 415,
    });
  });

  it("refuses images over 4096 px and damaged headers", () => {
    expect(inspectImage("logo", png(4097, 1))).toMatchObject({
      status: 422,
      code: "image_too_large",
      message: /4096 px/,
    });
    expect(inspectImage("logo", jpeg(10, 5000))).toMatchObject({ code: "image_too_large" });
    expect(inspectImage("logo", webp(5000, 5000))).toMatchObject({ code: "image_too_large" });
    expect(inspectImage("logo", png().slice(0, 12))).toMatchObject({ code: "invalid_image" });
    expect(inspectImage("logo", jpeg().slice(0, 6))).toMatchObject({ code: "invalid_image" });
    expect(inspectImage("logo", png(0, 5))).toMatchObject({ code: "invalid_image" });
    expect(inspectImage("favicon", ico().slice(0, 10))).toMatchObject({ code: "invalid_image" });
  });

  it("refuses an SVG with the reason", () => {
    expect(inspectImage("logo", svg("<script/>"))).toMatchObject({
      status: 422,
      code: "svg_refused",
      message: /<script>/,
    });
  });
});
