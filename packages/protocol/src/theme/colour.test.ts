import { describe, expect, it } from "vitest";
import { adjustLightness, contrastRatio, parseHex, relativeLuminance, toHex } from "./colour.js";

describe("colour", () => {
  it("parses and prints #rrggbb", () => {
    expect(parseHex("#2449c7")).toEqual({ r: 0x24, g: 0x49, b: 0xc7 });
    expect(toHex({ r: 0x24, g: 0x49, b: 0xc7 })).toBe("#2449c7");
    expect(toHex({ r: 300, g: -4, b: 15.6 })).toBe("#ff0010");
    expect(() => parseHex("#fff")).toThrow();
    expect(() => parseHex("red")).toThrow();
  });

  it("computes WCAG luminance and contrast", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
    expect(relativeLuminance("#000000")).toBe(0);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 6);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 6);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#123456", "#123456")).toBe(1);
  });

  it("adjusts lightness while staying in sRGB", () => {
    const darker = adjustLightness("#2449c7", -0.1);
    const lighter = adjustLightness("#2449c7", 0.1);
    expect(relativeLuminance(darker)).toBeLessThan(relativeLuminance("#2449c7"));
    expect(relativeLuminance(lighter)).toBeGreaterThan(relativeLuminance("#2449c7"));
    expect(adjustLightness("#2449c7", 0)).toBe("#2449c7");
    expect(adjustLightness("#2449c7", 2)).toBe("#ffffff");
    expect(adjustLightness("#2449c7", -2)).toBe("#000000");
    expect(adjustLightness("#ff0000", 0.2)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
