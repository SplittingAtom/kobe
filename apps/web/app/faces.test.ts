import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FACE_VARIABLES } from "../lib/theme/presets";

/**
 * KOBE-555 (ac-1): Outfit and JetBrains Mono ship as variable WOFF2 files through next/font/local
 * (swap, CSS variables) with their OFL beside them. next/font only runs inside Next's compiler, so
 * this reads app/faces.ts as source.
 */
const APP = dirname(fileURLToPath(import.meta.url));
const FACES = readFileSync(join(APP, "faces.ts"), "utf8");

const calls = [...FACES.matchAll(/localFont\(\{([\s\S]*?)\}\);/g)].map((m) => m[1] as string);
const option = (call: string, key: string): string | undefined =>
  new RegExp(`\\b${key}:\\s*("[^"]*"|\\w+)`).exec(call)?.[1]?.replace(/^"|"$/g, "");

describe("shipped faces (KOBE-555)", () => {
  it("loads both faces with next/font/local, swap, no preload, metric fallback, under FACE_VARIABLES", () => {
    expect(FACES).toMatch(/^import localFont from "next\/font\/local";$/m);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => option(c, "variable"))).toEqual([
      FACE_VARIABLES.outfit,
      FACE_VARIABLES.jetbrainsMono,
    ]);
    for (const call of calls) {
      expect(option(call, "display")).toBe("swap");
      expect(option(call, "preload")).toBe("false");
    }
    // A metric-matched Arial under Outfit limits the swap's layout shift; next/font has no
    // monospaced metric fallback, so JetBrains Mono falls back to the system mono stack.
    expect(calls.map((c) => option(c, "adjustFontFallback"))).toEqual(["Arial", "false"]);
  });

  it("ships each file as variable WOFF2 under its own name, with the project's OFL beside it", () => {
    const srcs = calls.map((c) => option(c, "src") ?? "");
    expect(srcs).toEqual([
      "./fonts/outfit/Outfit[wght].woff2",
      "./fonts/jetbrains-mono/JetBrainsMono[wght].woff2",
    ]);
    for (const src of srcs) {
      const file = join(APP, src);
      expect(readFileSync(file).subarray(0, 4).toString("latin1"), src).toBe("wOF2");
      const ofl = readFileSync(join(dirname(file), "OFL.txt"), "utf8");
      expect(ofl).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
    expect(readdirSync(join(APP, "fonts")).sort()).toEqual(["jetbrains-mono", "outfit"]);
  });
});
