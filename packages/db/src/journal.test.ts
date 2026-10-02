import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_FOLDER } from "./migrate.js";

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

const journal = JSON.parse(
  readFileSync(`${DEFAULT_MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8"),
) as Journal;

describe("migration journal", () => {
  // Drizzle applies only migrations newer than the last applied `when`; an out-of-order entry
  // (e.g. from a branch merged later) would be silently skipped on existing installs.
  it("has strictly increasing timestamps in index order", () => {
    const whens = journal.entries.map((e) => e.when);
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
    expect(whens.every((w, i) => i === 0 || w > (whens[i - 1] ?? 0))).toBe(true);
  });
});
