import { describe, expect, it } from "vitest";
import { addQuantities, scaleQuantity, toMilli } from "./quantities.js";

describe("quantities (KOBE-325)", () => {
  it("adds and scales exactly across suffixes", () => {
    expect(addQuantities("20", "2")).toBe("22");
    expect(addQuantities("500m", "1")).toBe("1500m");
    expect(addQuantities("40Gi", "4Gi")).toBe(String(44 * 2 ** 30));
    expect(scaleQuantity("1Gi", 4)).toBe(String(4 * 2 ** 30));
    expect(scaleQuantity("500m", 4)).toBe("2");
    expect(toMilli("1.5")).toBe(1500n);
  });

  it("refuses what is not a quantity", () => {
    expect(() => toMilli("4 Gi")).toThrow(/not a quantity/);
  });
});
