import { describe, expect, it } from "vitest";
import { resolveIdleMinutes } from "./idle.js";

describe("resolveIdleMinutes (D14: 15 minutes, team range 5–60)", () => {
  it("uses a team setting within 5–60", () => {
    expect(resolveIdleMinutes(5, 15)).toBe(5);
    expect(resolveIdleMinutes(60, 15)).toBe(60);
    expect(resolveIdleMinutes(30, 15)).toBe(30);
  });

  it("falls back to the install default for anything else", () => {
    for (const bad of [undefined, null, 4, 61, 7.5, "30", {}, -1]) {
      expect(resolveIdleMinutes(bad, 15)).toBe(15);
    }
  });
});
