import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KOBE-282 (ac-1, ac-3): one theme source. app/theme.css (loaded by the root layout, so every page
 * and every portal has it) declares the tokens on `:root`; the dark values apply when
 * `<html data-theme="dark">`, or with no saved choice when the OS is dark. Other stylesheets only
 * read the tokens. happy-dom has no cascade, so this pins the CSS contract; gate1 screenshots check
 * the rendering in both schemes.
 */
const WEB = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) =>
  readFileSync(join(WEB, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const THEME = read("app/theme.css");

/** The body of the first block whose prelude is exactly `prelude` (nested blocks included). */
function block(source: string, prelude: string): string {
  const re = new RegExp(`(^|[}\\s;])${prelude.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
  const m = re.exec(source);
  if (!m) throw new Error(`no block ${prelude}`);
  let depth = 1;
  const start = m.index + m[0].length;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i);
  }
  throw new Error(`unclosed block ${prelude}`);
}

/** `name: value` pairs of a flat declaration block, in order. */
function declarations(body: string): [string, string][] {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
    });
}

function cssFiles(dir: string): string[] {
  return readdirSync(join(WEB, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return cssFiles(path);
    return e.name.endsWith(".css") ? [path] : [];
  });
}

/** The stylesheet without its Tailwind dark variant (checked on its own below). */
const withoutVariant = (s: string) =>
  s.includes("@custom-variant dark") ? s.replace(block(s, "@custom-variant dark"), "") : s;

describe("theme tokens (KOBE-282)", () => {
  const light = declarations(block(THEME, ":root"));
  const chosenDark = declarations(block(THEME, ':root[data-theme="dark"]'));
  const osDark = declarations(
    block(block(THEME, "@media (prefers-color-scheme: dark)"), ':root:not([data-theme="light"])'),
  );

  it("with no choice both schemes are allowed and the OS decides", () => {
    expect(light).toContainEqual(["color-scheme", "light dark"]);
  });

  it("a saved light choice is light even on a dark OS", () => {
    expect(declarations(block(THEME, ':root[data-theme="light"]'))).toEqual([
      ["color-scheme", "light"],
    ]);
  });

  it("the chosen-dark and OS-dark blocks set the same values, color-scheme included", () => {
    expect(osDark).toEqual(chosenDark);
    expect(chosenDark).toContainEqual(["color-scheme", "dark"]);
  });

  it("every dark token has a light value, and the chat, console and gauge palettes are here", () => {
    const lightNames = new Set(light.map(([n]) => n));
    for (const [name] of chosenDark) expect(lightNames).toContain(name);
    for (const token of [
      "--background",
      "--popover",
      "--border",
      "--input",
      "--admin-accent",
      "--admin-warn-bg",
      "--kobe-console-bg",
      "--kobe-gauge-ok",
      "--kobe-when-light",
      "--kobe-when-dark",
    ])
      expect(lightNames).toContain(token);
  });

  it("no other stylesheet switches on the OS setting itself", () => {
    const offenders = [...cssFiles("app"), ...cssFiles("components")]
      .filter((f) => f !== join("app", "theme.css"))
      .filter((f) => withoutVariant(read(f)).includes("prefers-color-scheme"))
      .map((f) => relative(".", f));
    expect(offenders).toEqual([]);
  });

  it("the shadcn tokens are no longer scoped to the chat root, so portals resolve them", () => {
    const chat = read("app/chat-global.css");
    expect(chat).not.toMatch(/--background\s*:/);
    expect(THEME).toMatch(/:root\s*\{[^}]*--popover\s*:/);
  });

  it("the root layout loads the theme for every page", () => {
    expect(read("app/layout.tsx")).toMatch(/import "\.\/theme\.css";/);
  });

  it("Tailwind's dark variant follows the same rule", () => {
    const variant = block(read("app/chat-global.css"), "@custom-variant dark");
    expect(variant).toContain('&:where([data-theme="dark"] *)');
    const media = block(variant, "@media (prefers-color-scheme: dark)");
    expect(media).toContain('&:where(:root:not([data-theme="light"]) *)');
  });
});
