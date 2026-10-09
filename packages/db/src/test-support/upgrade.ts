import { readFileSync } from "node:fs";
import pg from "pg";

export interface JournalEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
}

export function readJournal(folder: string): readonly JournalEntry[] {
  const raw = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as {
    entries: JournalEntry[];
  };
  return raw.entries;
}

/**
 * Drizzle applies only migrations whose `when` is newer than the last applied one, so a branch
 * migration older than the base's latest is silently skipped on an existing install while a fresh
 * database still gets it. Throws when `branch` does not extend `base` with strictly newer entries.
 */
export function assertJournalExtendsBase(baseFolder: string, branchFolder: string): void {
  const base = readJournal(baseFolder);
  const branch = readJournal(branchFolder);
  const branchTags = new Set(branch.map((e) => e.tag));
  const lost = base.filter((e) => !branchTags.has(e.tag)).map((e) => e.tag);
  if (lost.length > 0) {
    throw new Error(
      `branch lacks migrations from its base (merge the base branch): ${lost.join(", ")}`,
    );
  }
  const baseTags = new Set(base.map((e) => e.tag));
  const baseLatest = Math.max(0, ...base.map((e) => e.when));
  const stale = branch.filter((e) => !baseTags.has(e.tag) && e.when <= baseLatest);
  if (stale.length > 0) {
    throw new Error(
      `migrations older than the base's latest (${baseLatest}) are skipped on upgrade: ` +
        stale.map((e) => `${e.tag} (${e.when})`).join(", "),
    );
  }
}

/** Every journal entry of `folder` must have a row in Drizzle's bookkeeping table. */
export async function assertAllMigrationsApplied(ownerUrl: string, folder: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const res = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations",
    );
    const applied = Number(res.rows[0]?.n);
    const expected = readJournal(folder).length;
    if (applied !== expected) {
      throw new Error(`upgraded database applied ${applied} of ${expected} migrations (skipped?)`);
    }
  } finally {
    await client.end();
  }
}
