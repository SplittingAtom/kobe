import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KOBE-257 ac-1: "Site" replaced "Install" for the scope everywhere people read it. Code comments
 * and identifiers keep "install" until KOBE-255 renames them; text that renders must not.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCOPE_WORDING =
  /\binstall (admins?|owner|roles?|console|floor|ceiling|catalog|budget|maximum|invitations?|rules)\b|\binstall('|&apos;)s\b|\bthis install\b|\binstall-wide\b/i;
const COMMENT = /^\s*(\*|\/\/|\/\*|\{\/\*)/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [path] : [];
  });
}

describe("Site wording (KOBE-257)", () => {
  it("no rendered text calls the scope 'install'", () => {
    const hits = ["app", "components", "lib"]
      .flatMap((dir) => sources(join(ROOT, dir)))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${relative(ROOT, file)}:${i + 1}` }))
          .filter(({ line }) => !COMMENT.test(line) && SCOPE_WORDING.test(line))
          .map(({ at, line }) => `${at}: ${line.trim()}`),
      );
    expect(hits).toEqual([]);
  });
});
