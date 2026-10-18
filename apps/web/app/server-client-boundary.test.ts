import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KOBE-321 review B1: a server component (a file under app/ without "use client") may render a
 * component from a "use client" module, but never call one of its functions or read its values:
 * on the server those exports are client references, and calling one throws ("Attempted to call
 * x() from the server"), a 500 the build and jsdom tests don't catch. So every value it imports
 * from a client module must be a component (PascalCase); type-only imports are fine.
 */
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(WEB, "app");
const SOURCE = /\.(ts|tsx)$/;
const IMPORT = /import\s+(type\s+)?([\s\S]+?)\s+from\s+["']([^"']+)["']/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return SOURCE.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const isClient = (file: string) => /^\s*["']use client["']/.test(readFileSync(file, "utf8"));

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
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

describe("server components and client modules (KOBE-321 review B1)", () => {
  const files = sources(APP).filter((f) => !isClient(f));

  it("finds the server components", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("import only components (PascalCase) as values from client modules", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
        if (m[1]) continue;
        const target = resolveImport(file, m[3] ?? "");
        if (!target || !isClient(target)) continue;
        for (const name of valueNames(m[2] ?? "")) {
          if (!/^[A-Z][a-z0-9]/.test(name))
            offenders.push(`${relative(WEB, file)}: ${name} from ${relative(WEB, target)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
