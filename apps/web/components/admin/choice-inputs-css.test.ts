import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KOBE-283: a checkbox or radio sits inline before its text everywhere in the consoles. The bug was
 * `.form label { display: flex; flex-direction: column }`, which matched every label in a form, so
 * a choice label stacked its box on its own row (stretched, so drawn centred above the text).
 * happy-dom has no cascade, so this pins the CSS contract over every console stylesheet: a rule
 * that lays labels out as a block or column, or makes inputs fill their box, leaves choices out.
 */
const WEB = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) =>
  readFileSync(join(WEB, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function cssFiles(dir: string): string[] {
  return readdirSync(join(WEB, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return cssFiles(path);
    return e.name.endsWith(".css") ? [path] : [];
  });
}

/** Splits a selector list at its top-level commas (not those inside `:is()`, `:not()`, …). */
function selectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    if (list[i] === ")") depth--;
    if (list[i] === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...out, list.slice(start).trim()];
}

/** The last compound of a selector: what it styles (`.form label:not(…)` → `label:not(…)`). */
function subject(selector: string): string {
  let depth = 0;
  for (let i = selector.length - 1; i >= 0; i--) {
    if (selector[i] === ")") depth++;
    if (selector[i] === "(") depth--;
    if (depth === 0 && /[\s>+~]/.test(selector[i] ?? "")) return selector.slice(i + 1);
  }
  return selector;
}

interface Rule {
  readonly file: string;
  readonly selector: string;
  readonly body: string;
}

/** Innermost rules (nested `@media` blocks included), one entry per selector of each list. */
function rules(file: string): Rule[] {
  return [...read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) =>
    selectors(m[1] ?? "").map((selector) => ({ file, selector, body: m[2] ?? "" })),
  );
}

/** The consoles (admin and /me pages) and the global sheets every page loads. */
const CONSOLE_CSS = [
  ...cssFiles("components/admin"),
  ...cssFiles("components/me"),
  ...cssFiles("app"),
].flatMap(rules);
const LEAVES_CHOICES_OUT = /:not\(:has\(input:is\(\[type="checkbox"\], \[type="radio"\]\)\)\)/;
const SKIPS_CHOICES = /:not\(\[type="checkbox"\], \[type="radio"\]\)/;

const where = (r: Rule) => `${relative(".", r.file)}: ${r.selector}`;

describe("checkboxes and radios sit inline before their text (KOBE-283)", () => {
  it("no rule stacks or blocks every label: choice labels are left out", () => {
    const stacking = CONSOLE_CSS.filter(
      (r) =>
        /^label\b/.test(subject(r.selector)) &&
        /(display\s*:\s*(block|flex|grid)|flex-direction\s*:\s*column)/.test(r.body),
    );
    // Since KOBE-296 no console stylesheet lays labels out: fields are the primitives' `Field`
    // (label above the control) and choices their `Checkbox`/`Radio`, whose inline box is pinned
    // by a rendered test (components/ui/console/field.test.tsx). This keeps the global sheets
    // from bringing a stacking rule back.
    expect(stacking.filter((r) => !LEAVES_CHOICES_OUT.test(r.selector)).map(where)).toEqual([]);
  });

  it("no rule makes every input full width or a block: checkboxes and radios are skipped", () => {
    const filling = CONSOLE_CSS.filter(
      (r) =>
        /^input(?![\w[-])|^input:/.test(subject(r.selector)) &&
        /(width\s*:\s*100%|display\s*:\s*(block|flex|grid))/.test(r.body),
    );
    expect(filling.filter((r) => !SKIPS_CHOICES.test(r.selector)).map(where)).toEqual([]);
  });

  it("the connector tool list has no bullets", () => {
    // On Tailwind since KOBE-295: the list's own utilities, so its checkboxes lead each row.
    expect(read("components/admin/team/connectors-page.tsx")).toMatch(
      /<ul aria-label="Tools" className="[^"]*\blist-none\b[^"]*">/,
    );
  });
});
