import { describe, expect, it } from "vitest";
import { applyRailWidth, railWidthWithin } from "./rail-width";

/** KOBE-305 ac-2: the rail's width, read from the member's stored preferences, never trusted. */
describe("rail width", () => {
  it("applies a stored width only when it is a whole number within the bounds", () => {
    expect(applyRailWidth(360)).toBe(360);
    expect(applyRailWidth(200)).toBe(200);
    expect(applyRailWidth(560)).toBe(560);
    for (const bad of [199, 561, 300.5, Number.NaN, null, undefined]) {
      expect(applyRailWidth(bad), String(bad)).toBeNull();
    }
  });

  it("clamps a chosen width to the rail's own bounds", () => {
    expect(railWidthWithin(100)).toBe(200);
    expect(railWidthWithin(900)).toBe(560);
    expect(railWidthWithin(333.6)).toBe(334);
    expect(railWidthWithin(Number.NaN)).toBeNull();
    expect(railWidthWithin("300")).toBeNull();
  });
});
