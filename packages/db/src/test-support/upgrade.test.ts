import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_FOLDER } from "../migrate.js";
import { assertJournalExtendsBase, readJournal } from "./upgrade.js";

interface Entry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** A copy of the real migrations with `extra` appended to the journal (and an empty SQL file). */
function branchWith(extra: (last: Entry) => Entry[]): string {
  const dir = mkdtempSync(join(tmpdir(), "kobe-upgrade-"));
  cpSync(DEFAULT_MIGRATIONS_FOLDER, dir, { recursive: true });
  const path = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: Entry[] };
  const last = journal.entries.at(-1) as Entry;
  for (const e of extra(last)) {
    journal.entries.push(e);
    writeFileSync(join(dir, `${e.tag}.sql`), "SELECT 1;");
  }
  writeFileSync(path, JSON.stringify(journal));
  return dir;
}

const next = (last: Entry, when: number): Entry => ({
  ...last,
  idx: last.idx + 1,
  when,
  tag: "9999_probe",
});

describe("assertJournalExtendsBase", () => {
  it("accepts a branch identical to its base", () => {
    expect(() =>
      assertJournalExtendsBase(DEFAULT_MIGRATIONS_FOLDER, DEFAULT_MIGRATIONS_FOLDER),
    ).not.toThrow();
  });

  it("accepts a newer migration on top of the base", () => {
    const branch = branchWith((l) => [next(l, l.when + 1)]);
    expect(() => assertJournalExtendsBase(DEFAULT_MIGRATIONS_FOLDER, branch)).not.toThrow();
  });

  // ac-2: a migration older than the base's latest is skipped by Drizzle on an existing install.
  it("rejects a branch migration whose `when` is older than the base's latest", () => {
    const branch = branchWith((l) => [next(l, l.when - 1)]);
    expect(() => assertJournalExtendsBase(DEFAULT_MIGRATIONS_FOLDER, branch)).toThrow(
      /older than.*9999_probe/s,
    );
  });

  it("rejects a branch that lost a migration the base has", () => {
    const base = branchWith((l) => [next(l, l.when + 1)]);
    expect(() => assertJournalExtendsBase(base, DEFAULT_MIGRATIONS_FOLDER)).toThrow(/merge/i);
  });

  it("reads the journal", () => {
    expect(readJournal(DEFAULT_MIGRATIONS_FOLDER).length).toBeGreaterThan(0);
  });
});
