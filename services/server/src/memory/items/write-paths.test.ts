import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as create from "./create.js";
import * as edit from "./edit.js";
import * as imported from "./import.js";

/**
 * KOBE-379 review H-1: every path that writes or re-activates a memory statement runs the full
 * save checks (`saveChecks` -> `checkMemoryWrite`). This lists every write path of the item store;
 * a new one fails here until it is classified, and a write to the item tables outside the store
 * fails the source sweep below. Behaviour per path: `memory-checks.db.test.ts`.
 */
const CHECKED = {
  createItem: "a new statement",
  patchItem: "a statement change or a Policy change (tags alone: secret scan of the tags)",
  revertItem: "Undo: an earlier statement as a new version",
  restoreItem: "re-activates an archived statement",
} as const;
const EXEMPT = {
  archiveItem: "takes a statement out of use",
  pinItem: "ranks an active, already-checked statement; no text changes",
} as const;

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("memory write paths (review H-1)", () => {
  it("classifies every exported write of the item store", () => {
    const exported = [...Object.keys(create), ...Object.keys(edit)].filter(
      (k) =>
        typeof (create as Record<string, unknown>)[k] === "function" ||
        typeof (edit as Record<string, unknown>)[k] === "function",
    );
    expect(exported.sort()).toEqual([...Object.keys(CHECKED), ...Object.keys(EXEMPT)].sort());
  });

  it("runs the save checks on every path that writes or re-activates a statement", () => {
    const fns = { ...create, ...edit } as Record<string, (...a: never[]) => unknown>;
    for (const name of Object.keys(CHECKED))
      expect(String(fns[name]), name).toMatch(/\bsaveChecks\b/u);
    for (const name of Object.keys(EXEMPT))
      expect(String(fns[name]), name).not.toMatch(
        /status = 'active'|\binsertVersion\b|\bappendStatement\b/u,
      );
  });

  it("checks every imported row (KOBE-385): preview evaluates, commit enforces", () => {
    expect(Object.keys(imported).sort()).toEqual(["commitImport", "previewImport"]);
    expect(String(imported.previewImport)).toMatch(/\bclassify\b/u);
    expect(String(imported.commitImport)).toMatch(/\bclassify\b/u);
    expect(String(imported.commitImport)).toMatch(/\boutcomeOf\b/u);
  });

  it("writes memory items and versions only from the item store", () => {
    const WRITE =
      /(?:INSERT INTO|UPDATE)\s+(?:\$\{op\.loc\.(?:items|versions)\}|(?:semantic|portable|site)_memory_item(?:s|_versions)\b)|insertVersion\(op\./u;
    const writers = sources(SRC)
      .filter((path) => WRITE.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path))
      .sort();
    expect(writers).toEqual([
      "memory/items/create.ts",
      "memory/items/edit.ts",
      "memory/items/import.ts",
      "memory/items/versions.ts",
      // KOBE-386: the retention scrub only clears evidence and thread links (0222 refuses any
      // other change to a version), never a statement.
      "retention/semantic-memory.ts",
    ]);
  });
});
