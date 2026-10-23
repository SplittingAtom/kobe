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
    const variant = block(read("app/tailwind.css"), "@custom-variant dark");
    expect(variant).toContain('&:where([data-theme="dark"] *)');
    const media = block(variant, "@media (prefers-color-scheme: dark)");
    expect(media).toContain('&:where(:root:not([data-theme="light"]) *)');
  });
});

/** A colour from theme.css as relative luminance: `#rrggbb`, or an achromatic `oklch(L 0 0)`. */
function luminance(value: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16);
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  }
  // OKLab with no chroma: l = m = s = L³, so linear R = G = B = L³.
  const ok = /^oklch\(([\d.]+) 0 0\)$/.exec(value);
  if (ok) return Number(ok[1]) ** 3;
  throw new Error(`no luminance for ${value}`);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("status tokens (KOBE-301)", () => {
  const light = new Map(declarations(block(THEME, ":root")));
  const dark = new Map([...light, ...declarations(block(THEME, ':root[data-theme="dark"]'))]);
  /** A token's colour in a theme, following var() references. */
  const resolve = (theme: Map<string, string>, name: string): string => {
    const value = theme.get(name);
    if (value === undefined) throw new Error(`no ${name}`);
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    return ref ? resolve(theme, ref[1] as string) : value;
  };

  const TEXT = ["running", "attention", "failed", "done", "idle"] as const;
  // The page, the rail (`--admin-panel` = --muted) and cards (tool steps).
  const SURFACES = ["--background", "--muted", "--card"] as const;

  for (const [name, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`every status colour keeps AA (4.5:1) on every surface and on its tint (${name})`, () => {
      for (const status of TEXT) {
        const fg = resolve(theme, `--kobe-status-${status}`);
        for (const surface of SURFACES) {
          expect(contrast(fg, resolve(theme, surface)), `${status} on ${surface}`).toBeGreaterThan(
            4.5,
          );
        }
        if (theme.has(`--kobe-status-${status}-bg`)) {
          const tint = resolve(theme, `--kobe-status-${status}-bg`);
          expect(contrast(fg, tint), `${status} on its tint`).toBeGreaterThan(4.5);
        }
      }
      // The approval card's amber border and icon sit on the warning background.
      expect(
        contrast(resolve(theme, "--kobe-status-attention"), resolve(theme, "--admin-warn-bg")),
      ).toBeGreaterThan(4.5);
      // The count pill (notification bell): its text on the accent.
      expect(
        contrast(resolve(theme, "--kobe-status-accent-fg"), resolve(theme, "--kobe-status-accent")),
      ).toBeGreaterThan(4.5);
    });
  }

  for (const [name, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`console form-control borders keep 3:1 on the page and the panel (${name}, KOBE-294)`, () => {
      const border = resolve(theme, "--kobe-console-control-border");
      for (const surface of ["--kobe-console-bg", "--kobe-console-panel"]) {
        expect(contrast(border, resolve(theme, surface)), surface).toBeGreaterThanOrEqual(3);
      }
    });
  }

  for (const [name, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`white on the confirm button keeps AA, hovered too (${name})`, () => {
      const fg = resolve(theme, "--kobe-confirm-fg");
      for (const bg of ["--kobe-confirm", "--kobe-confirm-hover"]) {
        expect(contrast(fg, resolve(theme, bg)), bg).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`the gold tool badge keeps AA on its tint and on cards (${name}, KOBE-374)`, () => {
      const gold = resolve(theme, "--kobe-tool-badge");
      for (const surface of ["--kobe-tool-badge-bg", "--card", "--background"]) {
        expect(contrast(gold, resolve(theme, surface)), surface).toBeGreaterThanOrEqual(4.5);
      }
      // Gold is the tool's identity, not an outcome: it is none of the status colours.
      for (const status of ["running", "attention", "failed", "done"]) {
        expect(gold).not.toBe(resolve(theme, `--kobe-status-${status}`));
      }
    });

    it(`the composer's focus and running outlines keep 3:1 on the page, panels and cards (${name}, KOBE-374)`, () => {
      for (const outline of ["--kobe-composer-focus", "--kobe-status-running"]) {
        for (const surface of ["--background", "--muted", "--card"]) {
          expect(
            contrast(resolve(theme, outline), resolve(theme, surface)),
            `${outline} on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }

  /** `fg` at `alpha` over `bg` (both #rrggbb), as #rrggbb: a `bg-x/90` hover over the page. */
  const over = (fg: string, alpha: number, bg: string): string => {
    // An achromatic oklch(L 0 0) is grey with linear channel L³ (see luminance()).
    const grey = /^oklch\(([\d.]+) 0 0\)$/.exec(bg);
    const lin = grey ? Number(grey[1]) ** 3 : 0;
    const srgb = lin <= 0.0031308 ? 12.92 * lin : 1.055 * lin ** (1 / 2.4) - 0.055;
    const ch = (hex: string, i: number) =>
      hex.startsWith("#")
        ? Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
        : Math.round(255 * srgb);
    const mix = [0, 1, 2].map((i) => Math.round(alpha * ch(fg, i) + (1 - alpha) * ch(bg, i)));
    return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  };

  for (const [name, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`blue fills carry white text with AA, at rest and on hover (${name}, KOBE-479)`, () => {
      // The accent is the one blue fill (console primary button, accent badge, count pill).
      expect(resolve(theme, "--kobe-status-accent-fg")).toBe("#ffffff");
      const fill = resolve(theme, "--kobe-status-accent");
      const page = ["--kobe-console-bg", "--kobe-console-panel", "--background", "--card"];
      for (const fillOn of [fill, ...page.map((s) => over(fill, 0.9, resolve(theme, s)))]) {
        expect(contrast("#ffffff", fillOn), `white on ${fillOn}`).toBeGreaterThanOrEqual(4.5);
      }
      // The info notice's icon reads the same token: 3:1 (WCAG 1.4.11) on the page and panels.
      for (const surface of page) {
        expect(contrast(fill, resolve(theme, surface)), surface).toBeGreaterThanOrEqual(3);
      }
    });
  }

  for (const [name, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`the file editor's diff keeps text readable on green and red, and its marks AA (${name}, KOBE-463)`, () => {
      for (const kind of ["added", "deleted"] as const) {
        const tint = resolve(theme, `--kobe-diff-${kind}-bg`);
        expect(contrast(resolve(theme, "--foreground"), tint), `text on ${kind}`).toBeGreaterThan(
          4.5,
        );
        expect(
          contrast(resolve(theme, `--kobe-diff-${kind}`), tint),
          `${kind} mark`,
        ).toBeGreaterThan(4.5);
      }
      expect(resolve(theme, "--kobe-diff-added")).toBe(resolve(theme, "--kobe-status-running"));
      expect(resolve(theme, "--kobe-diff-deleted")).toBe(resolve(theme, "--kobe-status-failed"));
    });
  }

  it("the gauges read the status colours, and both dark blocks set the same ones", () => {
    expect(light.get("--kobe-gauge-warn")).toBe("var(--kobe-status-attention)");
    expect(light.get("--kobe-gauge-full")).toBe("var(--kobe-status-failed)");
    const css = read("components/shell/context-gauge.module.css");
    expect(css).toContain("var(--kobe-gauge-full)");
  });
});
