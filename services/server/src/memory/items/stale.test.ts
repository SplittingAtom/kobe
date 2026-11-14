import { describe, expect, it } from "vitest";
import { isStale } from "./stale.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const item = (over: Partial<Parameters<typeof isStale>[0]> = {}) => ({
  status: "active" as const,
  updated_at: daysAgo(100),
  as_of: null,
  ...over,
});

describe("isStale (KOBE-386)", () => {
  it("an active item unchanged for longer than the threshold is stale", () => {
    expect(isStale(item(), 90, NOW)).toBe(true);
    expect(isStale(item({ updated_at: daysAgo(89) }), 90, NOW)).toBe(false);
  });

  it("a recent as_of keeps an old item fresh; an old as_of does not", () => {
    expect(isStale(item({ as_of: "2026-10-01" }), 90, NOW)).toBe(false);
    expect(isStale(item({ as_of: "2026-01-01" }), 90, NOW)).toBe(true);
    expect(isStale(item({ updated_at: daysAgo(1), as_of: "2020-01-01" }), 90, NOW)).toBe(false);
  });

  it("only active items are stale; the threshold is the Site setting", () => {
    expect(isStale(item({ status: "archived" }), 90, NOW)).toBe(false);
    expect(isStale(item({ updated_at: daysAgo(10) }), 7, NOW)).toBe(true);
  });
});
