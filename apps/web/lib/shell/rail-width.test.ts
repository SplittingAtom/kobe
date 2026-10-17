import { afterEach, describe, expect, it, vi } from "vitest";
import { RAIL_WIDTH_KEY, railWidthWithin, readRailWidth, writeRailWidth } from "./rail-width";

/** KOBE-305 ac-2: the rail's width, remembered in this browser and read leniently. */
function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("rail width storage", () => {
  it("round-trips a width and forgets it on reset", () => {
    const s = memory();
    writeRailWidth(360, s);
    expect(s.items.get(RAIL_WIDTH_KEY)).toBe("360");
    expect(readRailWidth(s)).toBe(360);
    writeRailWidth(null, s);
    expect(s.items.has(RAIL_WIDTH_KEY)).toBe(false);
    expect(readRailWidth(s)).toBeNull();
  });

  it("ignores anything that isn't a whole width within the bounds", () => {
    for (const raw of ["199", "561", "abc", "", "300.5", "-300", "1e3", " 300", "99999"]) {
      expect(readRailWidth(memory({ [RAIL_WIDTH_KEY]: raw })), raw).toBeNull();
    }
    expect(readRailWidth(memory({ [RAIL_WIDTH_KEY]: "200" }))).toBe(200);
    expect(readRailWidth(memory({ [RAIL_WIDTH_KEY]: "560" }))).toBe(560);
  });

  it("survives storage that throws: nothing read, nothing thrown", () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readRailWidth(blocked)).toBeNull();
    expect(() => writeRailWidth(300, blocked)).not.toThrow();
    expect(() => writeRailWidth(null, blocked)).not.toThrow();
  });

  it("clamps a chosen width to the rail's own bounds", () => {
    expect(railWidthWithin(100)).toBe(200);
    expect(railWidthWithin(900)).toBe(560);
    expect(railWidthWithin(333.6)).toBe(334);
    expect(railWidthWithin(Number.NaN)).toBeNull();
    expect(railWidthWithin("300")).toBeNull();
  });
});
