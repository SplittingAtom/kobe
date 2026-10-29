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

/** Source files under `dir` with one of `exts`, tests excluded. */
function sourceFiles(dir: string, exts: readonly string[]): string[] {
  return readdirSync(join(WEB, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path, exts);
    if (/\.test\.tsx?$/.test(e.name)) return [];
    return exts.some((x) => e.name.endsWith(x)) ? [path] : [];
  });
}

/** Every `name: value` declaration in a stylesheet (comments stripped), with its file. */
function allDeclarations(
  files: readonly string[],
): { file: string; name: string; value: string }[] {
  return files.flatMap((file) =>
    [...read(file).matchAll(/([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)].map((m) => ({
      file,
      name: (m[1] as string).toLowerCase(),
      value: (m[2] as string).trim(),
    })),
  );
}

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/i;
/** A hex colour or colour function inside a string in TS/TSX (`"#fff"`, `"rgb(…)"`). */
const TS_COLOUR_LITERAL =
  /["'`](?:[^"'`]*\s)?#[0-9a-f]{3,8}["'`\s;,)]|\b(?:rgba?|hsla?|oklch|oklab|hwb)\(/i;
const PALETTE =
  /(?:^|[\s"'`:])(?:text|bg|border(?:-[trblxy])?|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|divide|accent|caret|placeholder|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/;

describe("tokenization guard (KOBE-498)", () => {
  const css = [...cssFiles("app"), ...cssFiles("components")].filter(
    (f) => f !== join("app", "theme.css"),
  );
  const decls = allDeclarations(css);
  const ts = [
    ...sourceFiles("app", [".tsx", ".ts"]),
    ...sourceFiles("components", [".tsx", ".ts"]),
  ];
  const where = (d: { file: string; name: string; value: string }) =>
    `${d.file}: ${d.name}: ${d.value}`;

  it("no stylesheet but theme.css holds a colour literal", () => {
    expect(decls.filter((d) => COLOUR_LITERAL.test(d.value)).map(where)).toEqual([]);
  });

  it("no shadow carries a colour of its own", () => {
    const named = /\b(?:black|white|gr[ae]y)\b/i;
    expect(
      decls
        .filter((d) => d.name === "box-shadow" || d.name === "text-shadow")
        .filter((d) => COLOUR_LITERAL.test(d.value) || named.test(d.value))
        .map(where),
    ).toEqual([]);
  });

  it("font families come from the tokens", () => {
    const ok = /^(?:var\(--kobe-font-[\w-]+\)|inherit|initial|unset)$/;
    expect(
      decls
        .filter((d) => d.name === "font-family")
        .filter((d) => !ok.test(d.value))
        .map(where),
    ).toEqual([]);
    const tsFonts = ts.flatMap((f) =>
      [...read(f).matchAll(/fontFamily\s*:\s*([^,}\n]+(?:,[^}\n]+)?)/g)]
        .map((m) => (m[1] as string).trim())
        .filter((v) => !/^["'`]var\(--kobe-font-[\w-]+\)["'`]$/.test(v))
        .map((v) => `${f}: ${v}`),
    );
    expect(tsFonts).toEqual([]);
  });

  it("corners come from the radius tokens", () => {
    const ok =
      /^(?:var\(--kobe-radius-[\w-]+\)|calc\(var\(--kobe-radius-[\w-]+\) \* [\d.]+\)|0|50%|inherit)$/;
    expect(
      decls
        .filter((d) => d.name === "border-radius")
        .filter((d) => !ok.test(d.value))
        .map(where),
    ).toEqual([]);
  });

  it("no TS/TSX source holds a colour literal or a Tailwind default-palette colour class", () => {
    const offenders = ts.flatMap((f) =>
      readFileSync(join(WEB, f), "utf8")
        .split("\n")
        .flatMap((line, i) =>
          COLOUR_LITERAL_TS(line) || PALETTE.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [],
        ),
    );
    expect(offenders).toEqual([]);
  });

  it("the guard itself catches what it should", () => {
    expect(COLOUR_LITERAL.test("0 4px 16px rgb(0 0 0 / 15%)")).toBe(true);
    expect(COLOUR_LITERAL.test("var(--admin-border, #d0d0d0)")).toBe(true);
    expect(COLOUR_LITERAL.test("var(--kobe-shadow-pop)")).toBe(false);
    expect(PALETTE.test('className="text-amber-700 dark:text-amber-400"')).toBe(true);
    expect(PALETTE.test('className="text-status-attention bg-muted"')).toBe(false);
    expect(COLOUR_LITERAL_TS('const c = "#c62828";')).toBe(true);
    expect(COLOUR_LITERAL_TS("TODO(KOBE-184): see PR #150")).toBe(false);
  });
});

function COLOUR_LITERAL_TS(line: string): boolean {
  return TS_COLOUR_LITERAL.test(line);
}

describe("design tokens (KOBE-498)", () => {
  const light = new Map(declarations(block(THEME, ":root")));
  const chosenDark = new Map(declarations(block(THEME, ':root[data-theme="dark"]')));
  const dark = new Map([...light, ...chosenDark]);
  const resolve = (theme: Map<string, string>, name: string): string => {
    const value = theme.get(name);
    if (value === undefined) throw new Error(`no ${name}`);
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    return ref ? resolve(theme, ref[1] as string) : value;
  };
  const BRAND = [
    "--kobe-brand-primary",
    "--kobe-brand-primary-hover",
    "--kobe-brand-primary-fg",
    "--kobe-brand-link",
    "--kobe-brand-focus",
  ];
  const THEMED = [
    ...BRAND.filter((t) => t !== "--kobe-brand-primary-hover"),
    "--kobe-shadow-pop",
    "--kobe-shadow-drawer",
    "--kobe-shadow-panel",
    "--kobe-scrim",
  ];
  const FIXED = [
    "--kobe-font-sans",
    "--kobe-font-mono",
    "--kobe-brand-wordmark-size",
    "--kobe-brand-wordmark-weight",
    "--kobe-radius-sm",
    "--kobe-radius-md",
    "--kobe-radius-lg",
    "--kobe-radius-xl",
    "--kobe-radius-pill",
  ];

  it("every T2 token has a light value, and the themed ones a dark value", () => {
    for (const token of [...BRAND, ...THEMED, ...FIXED]) expect(light.has(token), token).toBe(true);
    for (const token of THEMED) expect(chosenDark.has(token), token).toBe(true);
  });

  it("the existing accents read the brand layer and keep today's values", () => {
    expect(light.get("--admin-accent")).toBe("var(--kobe-brand-link)");
    expect(light.get("--kobe-status-accent")).toBe("var(--kobe-brand-primary)");
    expect(light.get("--kobe-status-accent-fg")).toBe("var(--kobe-brand-primary-fg)");
    for (const alias of ["--admin-accent", "--kobe-status-accent", "--kobe-status-accent-fg"])
      expect(chosenDark.has(alias), alias).toBe(false);
    // Today's colours (KOBE-479), so nothing on screen changes.
    const today = {
      light: {
        "--admin-accent": "#2449c7",
        "--kobe-status-accent": "#2449c7",
        "--kobe-status-accent-fg": "#ffffff",
        "--ring": "oklch(0.708 0 0)",
        "--kobe-composer-focus": "#52525b",
      },
      dark: {
        "--admin-accent": "#8fa8ff",
        "--kobe-status-accent": "#4263eb",
        "--kobe-status-accent-fg": "#ffffff",
        "--ring": "oklch(0.556 0 0)",
        "--kobe-composer-focus": "#a1a1aa",
      },
    };
    for (const [token, value] of Object.entries(today.light))
      expect(resolve(light, token), token).toBe(value);
    for (const [token, value] of Object.entries(today.dark))
      expect(resolve(dark, token), token).toBe(value);
  });

  for (const [name, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`brand links keep AA and focus 3:1 on the page and panels (${name})`, () => {
      for (const surface of [
        "--kobe-console-bg",
        "--kobe-console-panel",
        "--background",
        "--muted",
      ]) {
        const bg = resolve(theme, surface);
        expect(contrast(resolve(theme, "--kobe-brand-link"), bg), surface).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(contrast(resolve(theme, "--kobe-brand-focus"), bg), surface).toBeGreaterThanOrEqual(
          3,
        );
      }
      expect(
        contrast(resolve(theme, "--kobe-brand-primary-fg"), resolve(theme, "--kobe-brand-primary")),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("corners reproduce Tailwind's default radii", () => {
    expect(light.get("--kobe-radius-sm")).toBe("0.25rem");
    expect(light.get("--kobe-radius-md")).toBe("0.375rem");
    expect(light.get("--kobe-radius-lg")).toBe("0.5rem");
    expect(light.get("--kobe-radius-xl")).toBe("0.75rem");
  });

  it("the --admin-* neutrals are aliases on :root, no longer scoped to the chat root", () => {
    const aliases = {
      "--admin-fg": "var(--foreground)",
      "--admin-muted": "var(--muted-foreground)",
      "--admin-bg": "var(--background)",
      "--admin-panel": "var(--muted)",
      "--admin-border": "var(--border)",
    };
    for (const [alias, value] of Object.entries(aliases))
      expect(light.get(alias), alias).toBe(value);
    expect(light.has("--admin-hover")).toBe(true);
    expect(read("components/chat/chat.module.css")).not.toMatch(/--admin-[\w-]+\s*:/);
  });

  it("every brand, font, radius and shadow token is mapped in tailwind.css", () => {
    const theme = block(read("app/tailwind.css"), "@theme inline");
    const tokens = [...light.keys()].filter((t) =>
      /^--kobe-(?:brand-(?!wordmark)|font-|radius-|shadow-)/.test(t),
    );
    expect(tokens.length).toBeGreaterThan(15);
    for (const token of tokens) expect(theme, token).toContain(`var(${token})`);
    expect(theme).toMatch(/--font-sans:\s*var\(--kobe-font-sans\)/);
    expect(theme).toMatch(/--font-mono:\s*var\(--kobe-font-mono\)/);
    for (const size of ["sm", "md", "lg", "xl"])
      expect(theme).toMatch(new RegExp(`--radius-${size}:\\s*var\\(--kobe-radius-${size}\\)`));
  });

  it("the wordmark reads its type tokens", () => {
    const wordmark = block(read("components/shell/shell.module.css"), ".wordmark");
    expect(wordmark).toContain("font-size: var(--kobe-brand-wordmark-size)");
    expect(wordmark).toContain("font-weight: var(--kobe-brand-wordmark-weight)");
  });
});
