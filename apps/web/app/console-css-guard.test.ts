// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss, { type ChildNode, type Root } from "postcss";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * KOBE-294: the consoles and My area move from CSS modules to Tailwind (295 and 296 finish it).
 * These guards keep the chat's styling where it was and let each migration step tighten what the
 * consoles may still use:
 *
 * - The chat and the consoles load the same Tailwind build (app/tailwind.css: theme and utilities,
 *   never preflight); the console stylesheet's own rules are scoped to the console root; the
 *   chat's own compiled rules match a committed snapshot. Changing the chat's styling on purpose
 *   means updating that snapshot (`vitest run app/console-css-guard.test.ts -u`) in the same PR.
 * - Console code imports only the CSS modules still listed in `CSS_MODULES`, and only classes they
 *   still define. When a page moves to the primitives (components/ui/console), add it to
 *   `ON_TAILWIND`; when the last user of a module (or of a class) is gone, delete it and drop it
 *   from `CSS_MODULES`.
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
    expect(read("app/page.tsx")).toContain('import "./chat-global.css";');
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

  it("the chat stylesheet never names the console root", () => {
    expect(selectors(own(chat)).filter((s) => s.includes("data-kobe-console"))).toEqual([]);
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
    expect(withoutComments(read("app/theme.css")).trimStart().startsWith(ORDER)).toBe(true);
    expect(withoutComments(read("app/tailwind.css"))).toContain(
      "@layer theme, base, kobe-legacy, components, utilities;",
    );
  });

  it("every console CSS module sits in kobe-legacy, below the utilities", () => {
    for (const module of CSS_MODULES) {
      const css = withoutComments(read(module)).trim();
      expect(css.startsWith("@layer kobe-legacy {"), module).toBe(true);
      expect(postcss.parse(css).nodes.length, module).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// CSS modules the consoles may still use (ac-2; tightened by KOBE-295 and KOBE-296)

/** Console and My-area code (components/memory and components/files are shared with the chat). */
const CONSOLE_DIRS = [
  "app/admin",
  "app/me",
  "components/admin",
  "components/me",
  "components/projects",
  "components/ui/console",
] as const;

/** The CSS modules console code may still import. Drop one when its last user moves. */
const CSS_MODULES = ["components/admin/admin.module.css"] as const;

/** Files on Tailwind and the console primitives: no CSS module. Add each page as it moves. */
const ON_TAILWIND = [
  "app/admin/layout.tsx",
  "components/admin/budgets/amount-fields.tsx",
  "components/admin/console-nav.tsx",
  "components/admin/console-shell.tsx",
  "components/admin/console-theme-toggle.tsx",
  "components/admin/error-notice.tsx",
  "components/admin/gallery-score.tsx",
  "components/admin/isolation-banner.tsx",
  "components/admin/overview.tsx",
  "components/admin/placeholder.tsx",
  "components/admin/policy-rules.tsx",
  "components/admin/shared-hosting-note.tsx",
  "components/admin/site/invites-page.tsx",
  "components/admin/site/memory-switches.tsx",
  "components/admin/site/model-catalog.tsx",
  "components/admin/site/model-limits.tsx",
  "components/admin/site/model-providers.tsx",
  "components/admin/site/models-page.tsx",
  "components/admin/site/roles-page.tsx",
  "components/admin/site/settings-page.tsx",
  "components/admin/site/site-budget.tsx",
  "components/admin/site/teams-page.tsx",
  "components/admin/site/usage-page.tsx",
  "components/admin/site/users-page.tsx",
  "components/admin/site/web-search-form.tsx",
  "components/admin/team/agent-builder/agent-builder-page.tsx",
  "components/admin/team/agent-builder/eval-report.tsx",
  "components/admin/team/agent-builder/eval-status.tsx",
  "components/admin/team/agent-builder/frontmatter-form.tsx",
  "components/admin/team/agent-builder/model-field.tsx",
  "components/admin/team/agent-builder/orbit-export-button.tsx",
  "components/admin/team/agent-builder/publish-dialog.tsx",
  "components/admin/team/agent-builder/test-pane.tsx",
  "components/admin/team/agent-builder/version-history.tsx",
  "components/admin/team/agent-inventory.tsx",
  "components/admin/team/agents-page.tsx",
  "components/admin/team/audit-page.tsx",
  "components/admin/team/break-glass-page.tsx",
  "components/admin/team/budgets-page.tsx",
  "components/admin/team/connectors-page.tsx",
  "components/admin/team/egress-headers.tsx",
  "components/admin/team/egress-page.tsx",
  "components/admin/team/egress-requests.tsx",
  "components/admin/team/eval-settings-page.tsx",
  "components/admin/team/followups-page.tsx",
  "components/admin/team/gallery-agents.tsx",
  "components/admin/team/invites-page.tsx",
  "components/admin/team/members-page.tsx",
  "components/admin/team/memory-page.tsx",
  "components/admin/team/memory-switches-form.tsx",
  "components/admin/team/models-page.tsx",
  "components/admin/team/policy-page.tsx",
  "components/admin/team/retention-page.tsx",
  "components/admin/team/schedules-page.tsx",
  "components/admin/team/skill-editor/files-editor.tsx",
  "components/admin/team/skill-editor/skill-editor-page.tsx",
  "components/admin/team/skill-editor/skill-reach.tsx",
  "components/admin/team/skill-editor/skills-page.tsx",
  "components/admin/team/skill-review-page.tsx",
  "components/admin/team/usage-page.tsx",
  "components/admin/team/web-search-page.tsx",
  "components/admin/usage/usage-chart.tsx",
  "components/admin/usage/usage-dashboard.tsx",
  "components/me/my-agents-shell.tsx",
] as const;

/**
 * Whole directories on Tailwind (KOBE-295: the Team console, and the usage and budget parts it
 * shares with the Site console): no file in them may import a CSS module, new files included.
 */
const TAILWIND_DIRS = [
  "app/admin/team",
  "components/admin/team",
  "components/admin/usage",
  "components/admin/budgets",
] as const;

function sources(dir: string): string[] {
  return readdirSync(join(WEB, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
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

interface ModuleImport {
  readonly file: string;
  readonly binding: string;
  /** Relative to apps/web. */
  readonly module: string;
}

/** `import x from`, `import * as x from` and bare `import "…module.css"` (binding ""). */
function moduleImports(file: string): ModuleImport[] {
  const re = /import\s+(?:(?:\*\s+as\s+)?(\w+)\s+from\s+)?["']([^"']+\.module\.css)["']/g;
  return [...read(file).matchAll(re)].map((m) => ({
    file,
    binding: m[1] ?? "",
    module: relative(WEB, join(WEB, dirname(file), m[2] ?? "")),
  }));
}

/** The class names a CSS module defines. */
function classes(module: string): Set<string> {
  return new Set(
    [...withoutComments(read(module)).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? ""),
  );
}

describe("console CSS modules (KOBE-294, KOBE-295, KOBE-296)", () => {
  const files = CONSOLE_DIRS.flatMap(sources);
  const imports = files.flatMap(moduleImports);

  it("console code imports only the CSS modules still allowed, and they exist", () => {
    const allowed = new Set<string>(CSS_MODULES);
    expect(
      imports
        .filter((i) => !allowed.has(i.module) || !existsSync(join(WEB, i.module)))
        .map((i) => `${i.file}: ${i.module}`),
    ).toEqual([]);
  });

  it("files on Tailwind import no CSS module", () => {
    for (const file of ON_TAILWIND) expect(existsSync(join(WEB, file)), file).toBe(true);
    expect(ON_TAILWIND.flatMap(moduleImports).map((i) => `${i.file}: ${i.module}`)).toEqual([]);
    // The primitives themselves never use one.
    expect(sources("components/ui/console").flatMap(moduleImports)).toEqual([]);
  });

  it("the Team console and its shared parts import no CSS module, and no module lives there", () => {
    const files = TAILWIND_DIRS.flatMap(sources);
    expect(files.length).toBeGreaterThan(40);
    expect(files.flatMap(moduleImports).map((i) => `${i.file}: ${i.module}`)).toEqual([]);
    expect(TAILWIND_DIRS.flatMap(cssModulesIn)).toEqual([]);
  });

  it("a file that uses the console primitives imports no CSS module (pages move whole)", () => {
    const usesPrimitives = (f: string) =>
      /from\s+"(?:\.\.?\/)+(?:components\/)?ui\/console(?:\/[\w-]+)?"/.test(read(f));
    const mixed = files.filter(
      (f) => usesPrimitives(f) || f.startsWith(join("components", "ui", "console")),
    );
    expect(mixed.length).toBeGreaterThan(ON_TAILWIND.length / 2);
    expect(mixed.flatMap(moduleImports).map((i) => `${i.file}: ${i.module}`)).toEqual([]);
  });

  it("every class console code takes from a CSS module is still defined there", () => {
    const missing = imports.flatMap(({ file, binding, module }) => {
      if (binding === "") return [];
      const defined = classes(module);
      const used = [
        ...read(file).matchAll(new RegExp(`\\b${binding}(?:\\.(\\w+)|\\["([\\w-]+)"\\])`, "g")),
      ].map((m) => m[1] ?? m[2] ?? "");
      return used.filter((c) => !defined.has(c)).map((c) => `${file}: ${binding}.${c}`);
    });
    expect([...new Set(missing)]).toEqual([]);
  });

  it("each allowed module is still used: drop it from CSS_MODULES once its last user moves", () => {
    const used = new Set(imports.map((i) => i.module));
    expect(CSS_MODULES.filter((m) => !used.has(m))).toEqual([]);
  });
});
