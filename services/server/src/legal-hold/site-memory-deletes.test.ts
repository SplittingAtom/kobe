import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * KOBE-647 review P2-L4: a delete of Site memory outside the two guarded paths would skip the
 * server's Site-hold check (and in REPEATABLE READ could miss a hold the 0225 guard reads late).
 * Allowed: the version cap's prune (`memory/items/versions.ts`, which asks `siteMemoryHeld` first)
 * and any file that runs its deletes through `withSiteMemoryPurge` / `siteMemoryHeld`.
 */
const SRC = new URL("../", import.meta.url).pathname;
const SITE_DELETE =
  /DELETE\s+FROM\s+(?:public\.)?"?(?:site_memory_items|site_memory_item_versions)\b|DELETE\s+FROM\s+\$\{\s*(?:\w+\.)?loc\.(?:items|versions)\s*\}/i;
const GUARDED = /\b(?:withSiteMemoryPurge|siteMemoryHeld)\b/;
const PRUNE = "memory/items/versions.ts";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe("Site memory deletes", () => {
  it("happen only in the prune path or behind the Site-hold check", () => {
    const offenders = sources(SRC)
      .map((path) => ({ rel: relative(SRC, path), text: readFileSync(path, "utf8") }))
      .filter(({ rel, text }) => rel !== PRUNE && SITE_DELETE.test(text) && !GUARDED.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("the prune path still asks for the Site hold", () => {
    const text = readFileSync(join(SRC, PRUNE), "utf8");
    expect(SITE_DELETE.test(text)).toBe(true);
    expect(text).toMatch(/siteMemoryHeld\(/);
  });

  it("catches an unguarded delete", () => {
    expect(
      SITE_DELETE.test("await tx.execute(sql`DELETE FROM site_memory_items WHERE id = ${id}`)"),
    ).toBe(true);
    expect(SITE_DELETE.test("sql`DELETE FROM ${op.loc.versions} WHERE x`")).toBe(true);
  });
});
