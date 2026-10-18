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
 * (re-review). Relative and `@/` (web root) imports are followed.
 */
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(WEB, "app");
const SOURCE = /\.(ts|tsx)$/;
const IMPORT = /(?:^|\n)\s*import\s+(type\s+)?([\s\S]+?)\s+from\s+["']([^"']+)["']/g;
const BARE_IMPORT = /(?:^|\n)\s*(?:import|export\s+(?:\*|\{[\s\S]*?\}))\s+from\s+["']([^"']+)["']/g;

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
    ];
    for (const spec of specs) {
      const target = resolveImport(file, spec);
      if (target && SOURCE.test(target) && !isClient(target) && !seen.has(target))
        todo.push(target);
    }
  }
  return [...seen];
}

function offenders(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      if (m[1]) continue;
      const target = resolveImport(file, m[3] ?? "");
      if (!target || !isClient(target)) continue;
      for (const name of valueNames(m[2] ?? "")) {
        if (!/^[A-Z][a-z0-9]/.test(name))
          out.push(`${relative(WEB, file)}: ${name} from ${relative(WEB, target)}`);
      }
    }
  }
  return out;
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

  it("imports only components (PascalCase) as values from client modules", () => {
    expect(offenders(files)).toEqual([]);
  });
});
