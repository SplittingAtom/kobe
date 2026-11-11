import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRESETS } from "../lib/theme/presets";

/**
 * KOBE-615 ac-4: the Proposed edit bubble's gold glow. `--kobe-glow-gold` (and its border) are
 * fixed tokens (docs/theming.md §4.4), set in light and both dark blocks of app/theme.css, so every
 * preset has them in both schemes; the glow breathes only without prefers-reduced-motion.
 */
const WEB = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) =>
  readFileSync(join(WEB, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const THEME = read("app/theme.css");
const CHAT = read("app/chat-global.css");

function block(source: string, prelude: string): string {
  const at = source.indexOf(`${prelude} {`);
  if (at < 0) throw new Error(`no block ${prelude}`);
  let depth = 1;
  const start = at + prelude.length + 2;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i);
  }
  throw new Error(`unclosed block ${prelude}`);
}

describe("the gold glow (ac-4)", () => {
  const blocks = {
    light: block(THEME, ":root"),
    chosenDark: block(THEME, ':root[data-theme="dark"]'),
    osDark: block(
      block(THEME, "@media (prefers-color-scheme: dark)"),
      ':root:not([data-theme="light"])',
    ),
  };
  for (const [scheme, body] of Object.entries(blocks)) {
    it(`is set in ${scheme}`, () => {
      expect(body).toMatch(/--kobe-glow-gold:\s*rgb\(/u);
      expect(body).toMatch(/--kobe-glow-gold-border:\s*#/u);
    });
  }

  it("no preset overrides it (fixed, like the tool badge)", () => {
    expect(JSON.stringify(PRESETS)).not.toContain("--kobe-glow-gold");
  });

  it("the bubble's class reads the tokens and stops moving under reduced motion", () => {
    const rule = block(CHAT, "[data-kobe-chat] .kobe-glow-gold");
    expect(rule).toContain("var(--kobe-glow-gold-border)");
    expect(rule).toContain("var(--kobe-glow-gold)");
    expect(rule).toContain("animation: kobe-glow-gold");
    const reduced = CHAT.slice(CHAT.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block(reduced, "[data-kobe-chat] .kobe-glow-gold")).toContain("animation: none");
  });
});
