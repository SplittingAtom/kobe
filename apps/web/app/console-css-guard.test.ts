// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss, { type ChildNode, type Root } from "postcss";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * KOBE-294: the consoles and My area move from CSS modules to Tailwind (KOBE-295 and KOBE-296
 * finished it). These guards keep the chat's styling where it was and the consoles on Tailwind:
 *
 * - The chat and the consoles load the same Tailwind build (app/tailwind.css: theme and utilities,
 *   never preflight); the console stylesheet's own rules are scoped to the console root; the
 *   chat's own compiled rules match a committed snapshot. Changing the chat's styling on purpose
 *   means updating that snapshot (`vitest run app/console-css-guard.test.ts -u`) in the same PR.
 * - Since KOBE-296 no file in the Site console, the Team console or the My area imports a CSS
 *   module, and none lives there: their pages use the console primitives (components/ui/console)
 *   and utilities only. A new page there that adds a module fails here.
 */
const WEB = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(WEB, path), "utf8");
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------------------------------------
// Tailwind on the consoles, without touching the chat (ac-1)

async function compile(path: string): Promise<Root> {
  const from = join(WEB, path);
  const out = await postcss([tailwindcss({ base: WEB })]).process(read(path), { from });
  return out.root;
}

/** Tailwind's generated part, which grows with every class used anywhere in the app. */
function generated(node: ChildNode): boolean {
  if (node.type === "comment") return true;
  if (node.type !== "atrule") return false;
  if (node.name === "layer") return ["theme", "utilities", "properties"].includes(node.params);
  if (node.name === "property") return node.params.startsWith("--tw-");
  // Tailwind's and tw-animate's keyframes (spin, pulse, enter, exit, …); Kobe's start with kobe-.
  if (node.name === "keyframes") return !node.params.startsWith("kobe-");
  return false;
}

/** How the chat's rules leave a console root (a My area page beside the thread) alone. */
const LEFT_OUT = ":where(:not([data-kobe-console], [data-kobe-console] *))";
/** A selector on one line, without the formatter's spaces inside parentheses. */
const flat = (s: string) => s.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");

const own = (root: Root) => root.nodes.filter((n) => !generated(n));
const layer = (root: Root, name: string) =>
  root.nodes.find((n) => n.type === "atrule" && n.name === "layer" && n.params === name);

/** Every selector of every style rule in `nodes` (inside @layer and @media too). */
function selectors(nodes: readonly ChildNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type === "rule") out.push(...node.selectors);
    if (node.type === "rule" || node.type === "atrule") {
      node.walkRules((rule) => {
        out.push(...rule.selectors);
      });
    }
  }
  return [...new Set(out)];
}

describe("Tailwind on the consoles (KOBE-294)", () => {
  let chat: Root;
  let consoles: Root;
  beforeAll(async () => {
    [chat, consoles] = await Promise.all([
      compile("app/chat-global.css"),
      compile("app/admin/admin-global.css"),
    ]);
  });

  it("one Tailwind entry: theme and utilities only, never preflight", () => {
    const entry = withoutComments(read("app/tailwind.css"));
    expect(entry).toContain('@import "tailwindcss/theme.css" layer(theme);');
    expect(entry).toContain('@import "tailwindcss/utilities.css" layer(utilities);');
    expect(entry).not.toMatch(/preflight|@import\s+"tailwindcss"\s*;/);
    // At-rules only (layers, imports, the dark variant, the token mapping): no style rule of its own.
    expect(entry.replace(/@custom-variant[\s\S]*?\n}\n|@theme inline \{[^}]*\}/g, "")).not.toMatch(
      /[{}]/,
    );
  });

  it("the chat and every console and My-area route load it", () => {
    expect(withoutComments(read("app/chat-global.css")).trimStart()).toMatch(
      /^@import "\.\/tailwind\.css";/,
    );
    expect(withoutComments(read("app/admin/admin-global.css")).trimStart()).toMatch(
      /^@import "\.\.\/tailwind\.css";/,
    );
    // The workspace (the chat and its panels, KOBE-452) is in the root layout.
    expect(read("components/shell/workspace-host.tsx")).toContain(
      'import "../../app/chat-global.css";',
    );
    // Layouts: /admin (landing, Site and Team consoles) and /me.
    expect(read("app/admin/layout.tsx")).toContain('import "./admin-global.css";');
    expect(read("app/me/layout.tsx")).toContain('import "../admin/admin-global.css";');
  });

  it("both pages get the same build, so a page holding both stylesheets gets identical copies", () => {
    for (const name of ["theme", "utilities"]) {
      expect(layer(consoles, name)?.toString(), `@layer ${name}`).toBe(
        layer(chat, name)?.toString(),
      );
    }
  });

  it("every rule of the console stylesheet is scoped to the console root", () => {
    const sels = selectors(own(consoles));
    expect(sels.length).toBeGreaterThan(0);
    expect(sels.filter((s) => !s.includes("[data-kobe-console]"))).toEqual([]);
  });

  it("the chat stylesheet names the console root only to leave it out", () => {
    // A My area page beside the thread (KOBE-424) is a console root inside the chat root.
    const named = selectors(own(chat))
      .map(flat)
      .filter((s) => s.includes("data-kobe-console"));
    expect(named.length).toBeGreaterThan(0);
    for (const s of named) {
      expect(s.replaceAll(LEFT_OUT, ""), s).not.toContain("data-kobe-console");
    }
  });

  it("no chat preflight rule reaches a console root inside the chat (KOBE-424)", () => {
    const base = layer(chat, "base");
    // The composer anchor names a chat-only element: nothing of a console page matches it.
    const scoped = selectors(base && base.type === "atrule" ? (base.nodes ?? []) : [])
      .map(flat)
      .filter((s) => s.startsWith("[data-kobe-chat]") && !s.includes("[data-kobe-composer-box]"));
    expect(scoped.length).toBeGreaterThan(5);
    expect(scoped.filter((s) => !s.includes(LEFT_OUT))).toEqual([]);
  });

  it("the chat's own compiled rules are unchanged", async () => {
    const css = own(chat)
      .map((n) => n.toString())
      .join("\n");
    await expect(`${css}\n`).toMatchFileSnapshot("__snapshots__/chat-global.own.css.snap");
  });

  it("the chat's token mapping, dark variant and layer order are unchanged", async () => {
    // The shared entry minus the consoles' own tokens: what the chat's utilities resolve to.
    const entry = withoutComments(read("app/tailwind.css"))
      .split("\n")
      .filter((line) => !/^\s*--color-console-/.test(line) && line.trim() !== "")
      .join("\n");
    await expect(`${entry}\n`).toMatchFileSnapshot("__snapshots__/chat-theme.css.snap");
  });

  it("the console base rules for plain links and focus stay (content relies on them)", () => {
    const sels = selectors(own(consoles));
    expect(sels).toContain("[data-kobe-console] a");
    expect(sels).toContain("[data-kobe-console] :focus-visible");
  });
});

describe("cascade layers (KOBE-294)", () => {
  const ORDER = "@layer properties, theme, base, kobe-legacy, components, utilities;";

  it("the root layout's stylesheet declares the order first, so it never depends on load order", () => {
    // `kobe-legacy` held the consoles' CSS modules until KOBE-296 and is empty now; it stays
    // declared so the chat's compiled layer order (pinned above) does not change.
    expect(withoutComments(read("app/theme.css")).trimStart().startsWith(ORDER)).toBe(true);
    expect(withoutComments(read("app/tailwind.css"))).toContain(
      "@layer theme, base, kobe-legacy, components, utilities;",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// No CSS modules in the consoles or the My area (KOBE-294, KOBE-295, KOBE-296)

/**
 * Console and My-area code: the Site and Team consoles, the My area (agents, skills, projects,
 * memory, schedules, connector keys) and the primitives. components/files is shared with the chat
 * and keeps its own module.
 */
const CONSOLE_DIRS = [
  "app/admin",
  "app/me",
  "components/admin",
  "components/me",
  "components/memory",
  "components/projects",
  "components/skills",
  "components/ui/console",
] as const;

/** The consoles' former CSS modules (KOBE-20, KOBE-43, the agent builder and skill editor). */
const REMOVED_MODULES = [
  "components/admin/admin.module.css",
  "components/admin/usage/usage.module.css",
  "components/admin/team/agent-builder/agent-builder.module.css",
  "components/admin/team/skill-editor/skill-editor.module.css",
] as const;

/** Source files under `dir`, tests included (a test's fixture must not bring a module back). */
function sources(dir: string): string[] {
  return readdirSync(join(WEB, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) ? [path] : [];
  });
}

/** CSS modules under `dir`. */
function cssModulesIn(dir: string): string[] {
  return readdirSync(join(WEB, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return cssModulesIn(path);
    return e.name.endsWith(".module.css") ? [path] : [];
  });
}

/**
 * Any import or re-export of a CSS module: default, namespace, named and mixed imports, a bare
 * `import "…module.css"`, `export … from`, and `require`/dynamic `import()` of one.
 */
const MODULE_IMPORT =
  /(?:(?:import|export)\s+(?:[^"';]*?\s+from\s+)?|(?:require|import)\s*\(\s*)["']([^"']+\.module\.css)["']/g;

/** Every CSS module a file imports or re-exports, relative to apps/web. */
function moduleImports(file: string): string[] {
  return [...read(file).matchAll(MODULE_IMPORT)].map((m) =>
    relative(WEB, join(WEB, dirname(file), m[1] ?? "")),
  );
}

/**
 * The global stylesheets console code may import: the two layouts load the console sheet, the
 * test panes (the agent builder's, the Workbench's, KOBE-323) the chat's (they render the chat).
 */
const CSS_IMPORTS: Readonly<Record<string, string>> = {
  [join("app", "admin", "layout.tsx")]: "./admin-global.css",
  [join("app", "me", "layout.tsx")]: "../admin/admin-global.css",
  [join("components", "admin", "team", "agent-builder", "test-pane.tsx")]:
    "../../../../app/chat-global.css",
  [join("components", "skills", "test-pane.tsx")]: "../../app/chat-global.css",
};

/**
 * Chat code that hosts a console page: the panel over the workspace (KOBE-452) is the chat's frame
 * (its own CSS module) around `PanelContent`, which lives with the primitives.
 */
const CONSOLE_BRIDGES = [
  join("components", "shell", "workspace-panel.tsx"),
  join("components", "shell", "workspace-panel.test.tsx"),
];

/** Pages that render a component built on the primitives and add no markup of their own. */
const DELEGATING_PAGES = [join("components", "me", "my-memory-page.tsx")];

describe("no CSS modules in the consoles or the My area (KOBE-296)", () => {
  const files = CONSOLE_DIRS.flatMap(sources);

  it("covers the whole Site console, Team console and My area", () => {
    expect(files.length).toBeGreaterThan(150);
    for (const dir of ["components/admin/site", "components/admin/team", "components/me"]) {
      expect(
        files.filter((f) => f.startsWith(join(...dir.split("/")))).length,
        dir,
      ).toBeGreaterThan(10);
    }
  });

  it("no console or My-area file imports a CSS module", () => {
    expect(files.flatMap((f) => moduleImports(f).map((m) => `${f}: ${m}`))).toEqual([]);
  });

  it("no CSS module lives in those trees, and the old console modules are gone", () => {
    expect(CONSOLE_DIRS.flatMap(cssModulesIn)).toEqual([]);
    for (const module of REMOVED_MODULES) expect(existsSync(join(WEB, module)), module).toBe(false);
  });

  it("only the console layouts import a stylesheet, and only the console one", () => {
    const cssImports = files.flatMap((f) =>
      [...read(f).matchAll(/import\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+\.css)["']/g)].map(
        (m) => `${f}: ${m[1] ?? ""}`,
      ),
    );
    expect(cssImports.sort()).toEqual(
      Object.entries(CSS_IMPORTS)
        .map(([file, css]) => `${file}: ${css}`)
        .sort(),
    );
  });

  it("the guard's matcher sees every way of importing a module", () => {
    // A self-check: if the regex stopped matching, the tests above would pass vacuously.
    const samples = [
      'import styles from "./a.module.css";',
      'import * as styles from "../b.module.css";',
      'import "./c.module.css";',
      'const s = require("./d.module.css");',
      'const s = await import("./e.module.css");',
    ];
    const re =
      /(?:import\s+(?:(?:\*\s+as\s+)?\w+\s+from\s+)?|(?:require|import)\s*\(\s*)["']([^"']+\.module\.css)["']/g;
    expect(samples.map((line) => [...line.matchAll(re)].length)).toEqual([1, 1, 1, 1, 1]);
  });

  it("console code lives in the guarded trees (a new console directory must join CONSOLE_DIRS)", () => {
    const guarded = (f: string) => CONSOLE_DIRS.some((d) => f.startsWith(join(...d.split("/"))));
    const consoleCode = (f: string) =>
      /from\s+"(?:\.\.?\/)+(?:components\/)?ui\/console(?:\/[\w-]+)?"|import\s+["'][^"']*admin-global\.css["']/.test(
        read(f),
      );
    const outside = ["app", "components"]
      .flatMap(sources)
      .filter((f) => !guarded(f) && f !== join("app", "console-css-guard.test.ts"))
      .filter((f) => !CONSOLE_BRIDGES.includes(f))
      .filter(consoleCode);
    expect(outside).toEqual([]);
  });

  it("pages use the console primitives", () => {
    const usesPrimitives = (f: string) =>
      /from\s+"(?:\.\.?\/)+(?:components\/)?ui\/console(?:\/[\w-]+)?"/.test(read(f));
    const pages = files.filter((f) => /-page\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
    expect(pages.length).toBeGreaterThan(40);
    expect(pages.filter((f) => !usesPrimitives(f) && !DELEGATING_PAGES.includes(f))).toEqual([]);
  });
});
