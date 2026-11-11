import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGuide } from "./loader.js";
import { llmsFullTxt, llmsTxt, pageMarkdown } from "./llms.js";

/**
 * KOBE-620 (KA-3 ac-1): the guide build moved from apps/web/lib/docs into this package without
 * changing a byte. `test/fixtures/expected` was written by the web's own code before the move
 * (same origin and branding), from the guide in `test/fixtures/guide`.
 */
const FIXTURES = fileURLToPath(new URL("../test/fixtures", import.meta.url));
const CTX = { appName: "Acme Chat", origin: "https://chat.example.com" };

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const root = join(FIXTURES, "guide");
const pages = buildGuide(
  walk(root)
    .sort()
    .map((p) => ({
      path: relative(root, p).split(sep).join("/"),
      content: readFileSync(p, "utf8"),
    })),
);
const expected = (name: string) => readFileSync(join(FIXTURES, "expected", name), "utf8");

describe("outputs are byte-equal to the web's before the move", () => {
  it("llms.txt", () => {
    expect(llmsTxt(pages, CTX)).toBe(expected("llms.txt"));
  });
  it("llms-full.txt", () => {
    expect(llmsFullTxt(pages, CTX)).toBe(expected("llms-full.txt"));
  });
  it("every page's .md", () => {
    expect(pages.length).toBe(4);
    for (const page of pages)
      expect(pageMarkdown(page, CTX.origin)).toBe(expected(`${page.slug.replace(/\//g, "__")}.md`));
  });
});
