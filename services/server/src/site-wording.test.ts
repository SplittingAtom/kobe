import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KOBE-257 ac-1: "Site" replaced "Install" for the scope in every message people read (errors,
 * emails, notices) of every service. Comments and identifiers keep "install" until KOBE-255.
 */
const SERVICES = fileURLToPath(new URL("../../", import.meta.url));
const SCOPE_WORDING =
  /\binstall (admins?|owner|roles?|console|floor|ceiling|catalog|budget|maximum|invitations?|policy|rules)\b|\binstall's\b|\bthis (kobe )?install\b|\binstall-wide\b/i;
const COMMENT = /^\s*(\*|\/\/|\/\*)/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : sources(path);
    return d.name.endsWith(".ts") && !/\.test\.ts$/.test(d.name) ? [path] : [];
  });
}

describe("Site wording (KOBE-257)", () => {
  it("no message calls the scope 'install'", () => {
    const services = readdirSync(SERVICES, { withFileTypes: true }).filter((d) => d.isDirectory());
    const hits = services
      .map((d) => join(SERVICES, d.name, "src"))
      .filter((src) => existsSync(src))
      .flatMap((src) => sources(src))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${relative(SERVICES, file)}:${i + 1}` }))
          .filter(({ line }) => !COMMENT.test(line) && SCOPE_WORDING.test(line))
          .map(({ at, line }) => `${at}: ${line.trim()}`),
      );
    expect(hits).toEqual([]);
  });
});
