import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KOBE-321 review B1: server code may render a component from a "use client" module, but never
 * call one of its functions or read its values: on the server those exports are client
 * references, and calling one throws ("Attempted to call x() from the server"), an error page the
 * build and jsdom tests don't catch. So every value server code imports from a client module must
 * be a component (PascalCase); type-only imports are fine.
 *
 * Server code is every module the server reaches from app/ without crossing into a client module:
 * the pages and layouts, and whatever plain modules they import, in components/ and lib/ too
 * (re-review). Relative and `@/` (web root) imports are followed, and so are plain barrels: a
 * value a plain module re-exports (`export { x } from`, `export * from`) out of a client module
 * is that client module's value (KOBE-322 review S5).
 *
 * Known gaps (not checked): values from a dynamic `import()` (its module is still followed); a
 * PascalCase export that is not a component (an object `Tabs = {...}`); a component called as a
 * function (`Foo()`); a client value imported and then re-exported with a bare `export { x }`.
 */
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(WEB, "app");
const SOURCE = /\.(ts|tsx)$/;
const IMPORT = /(?:^|\n)\s*import\s+(type\s+)?([\s\S]+?)\s+from\s+["']([^"']+)["']/g;
const BARE_IMPORT = /(?:^|\n)\s*(?:import|export\s+(?:\*|\{[\s\S]*?\}))\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
/** `export { a, type B, c as d } from "x"` and `export * from "x"` (not `export type {...}`). */
const RE_EXPORT = /(?:^|\n)\s*export\s+(\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/g;
const LOCAL_EXPORT =
  /(?:^|\n)\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
const LOCAL_EXPORT_LIST = /(?:^|\n)\s*export\s+(\{[\s\S]*?\})\s*(?:;|\n)/g;
const PASCAL = /^[A-Z][a-z0-9]/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return SOURCE.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Whether the module's first statement is "use client" (comments before it allowed). */
function isClient(file: string): boolean {
  const text = readFileSync(file, "utf8").replace(/^(\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*/, "");
  return /^\s*["']use client["']/.test(text);
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(WEB, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    join(base, "index.tsx"),
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The value names an import clause binds (`A, { b, type C, d as e }`, `* as ns`). */
function valueNames(clause: string): string[] {
  const names: string[] = [];
  const braces = /\{([\s\S]*)\}/.exec(clause);
  const outside = clause
    .replace(/\{[\s\S]*\}/, "")
    .replace(/,/g, " ")
    .trim();
  if (outside) names.push(...outside.split(/\s+/).filter((w) => w !== "*" && w !== "as"));
  for (const part of braces?.[1]?.split(",") ?? []) {
    const p = part.trim();
    if (!p || p.startsWith("type ")) continue;
    names.push(p.split(/\s+as\s+/).pop() ?? p);
  }
  return names;
}

/** Every server module: app/'s plain files and the plain modules they reach. */
function serverModules(): string[] {
  const seen = new Set<string>();
  const todo = sources(APP).filter((f) => !isClient(f));
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const specs = [
      ...[...text.matchAll(IMPORT)].filter((m) => !m[1]).map((m) => m[3] ?? ""),
      ...[...text.matchAll(BARE_IMPORT)].map((m) => m[1] ?? ""),
      ...[...text.matchAll(DYNAMIC_IMPORT)].map((m) => m[1] ?? ""),
    ];
    for (const spec of specs) {
      const target = resolveImport(file, spec);
      if (target && SOURCE.test(target) && !isClient(target) && !seen.has(target))
        todo.push(target);
    }
  }
  return [...seen];
}

/** The names an export list binds, as exported (`a, type B, c as d` gives a and d). */
function exportedNames(list: string): { readonly from: string; readonly as: string }[] {
  return list
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("type "))
    .map((p) => {
      const [from = p, as = from] = p.split(/\s+as\s+/);
      return { from, as };
    });
}

/** A client module's own value exports (declarations and `export { ... }` lists). */
function ownExports(text: string): string[] {
  return [
    ...[...text.matchAll(LOCAL_EXPORT)].map((m) => m[1] ?? ""),
    ...[...text.matchAll(LOCAL_EXPORT_LIST)].flatMap((m) =>
      exportedNames(m[1] ?? "").map((n) => n.as),
    ),
  ];
}

/**
 * The client values a module exports, by exported name: every value of a client module, and what
 * a plain module re-exports from one (through any number of plain barrels).
 */
function clientValues(file: string, seen: Set<string> = new Set()): Set<string> {
  const text = readFileSync(file, "utf8");
  if (isClient(file)) return new Set(ownExports(text));
  const out = new Set<string>();
  if (seen.has(file)) return out;
  seen.add(file);
  for (const m of text.matchAll(RE_EXPORT)) {
    const target = resolveImport(file, m[2] ?? "");
    if (!target || !SOURCE.test(target)) continue;
    const values = clientValues(target, seen);
    if (m[1] === "*") for (const v of values) out.add(v);
    else for (const n of exportedNames(m[1] ?? "")) if (values.has(n.from)) out.add(n.as);
  }
  return out;
}

/** The names an import clause takes from its module, as exported there (`b as c` gives b). */
function importedNames(clause: string): string[] {
  const braces = /\{([\s\S]*)\}/.exec(clause);
  const outside = clause
    .replace(/\{[\s\S]*\}/, "")
    .replace(/,/g, " ")
    .trim();
  const names = outside.startsWith("*") ? ["*"] : outside ? ["default"] : [];
  for (const part of braces?.[1]?.split(",") ?? []) {
    const p = part.trim();
    if (p && !p.startsWith("type ")) names.push(p.split(/\s+as\s+/)[0] ?? p);
  }
  return names;
}

/** The client values (not components) one server module's imports take. */
function offendersIn(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT)) {
    if (m[1]) continue;
    const target = resolveImport(file, m[3] ?? "");
    if (!target) continue;
    const where = `${relative(WEB, file)}: %s from ${relative(WEB, target)}`;
    if (isClient(target)) {
      for (const name of valueNames(m[2] ?? ""))
        if (!PASCAL.test(name)) out.push(where.replace("%s", name));
      continue;
    }
    const values = clientValues(target);
    if (values.size === 0) continue;
    for (const name of importedNames(m[2] ?? "")) {
      const bad =
        name === "*"
          ? [...values].filter((v) => !PASCAL.test(v))
          : values.has(name) && !PASCAL.test(name)
            ? [name]
            : [];
      for (const b of bad) out.push(where.replace("%s", b));
    }
  }
  return out;
}

function offenders(files: readonly string[]): string[] {
  return files.flatMap((file) => offendersIn(file, readFileSync(file, "utf8")));
}

describe("server code and client modules (KOBE-321 review B1)", () => {
  const files = serverModules();

  it("follows the server's modules beyond app/", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => relative(WEB, f).startsWith("lib/"))).toBe(true);
  });

  it("reads a directive after comments", () => {
    expect(isClient(join(WEB, "components/skills/skills-page.tsx"))).toBe(true);
    expect(isClient(join(WEB, "lib/skills/tabs.ts"))).toBe(false);
  });

  it("follows plain barrels to the client values they re-export (review S5)", () => {
    const barrel = join(WEB, "components/ui/console/index.ts");
    expect([...clientValues(barrel)]).toEqual(
      expect.arrayContaining(["eventTrigger", "useConfirm", "useFieldControl", "ConfirmDialog"]),
    );
    const page = join(APP, "probe/page.tsx");
    expect(
      offendersIn(
        page,
        `import { Button, eventTrigger as t, type Confirm } from "@/components/ui/console";`,
      ),
    ).toEqual(["app/probe/page.tsx: eventTrigger from components/ui/console/index.ts"]);
    expect(offendersIn(page, `import { Badge, Card } from "@/components/ui/console";`)).toEqual([]);
    expect(offendersIn(page, `import * as ui from "@/components/ui/console";`)).toEqual(
      expect.arrayContaining([expect.stringContaining("useConfirm")]),
    );
  });

  it("imports only components (PascalCase) as values from client modules", () => {
    expect(offenders(files)).toEqual([]);
  });
});
