import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { DEFAULT_MIGRATIONS_FOLDER } from "./migrate.js";

export interface WaitOptions {
  /** App-role connection; the runner grants it read access to the migration journal table. */
  readonly databaseUrl: string;
  readonly migrationsFolder?: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

interface JournalEntry {
  readonly when: number;
  readonly tag: string;
}

function latestMigration(folder: string): JournalEntry {
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as {
    entries: JournalEntry[];
  };
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error(`No migrations in ${folder}`);
  return latest;
}

async function appliedUpTo(databaseUrl: string): Promise<number | null> {
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const { rows } = await client.query<{ latest: string | null }>(
      `SELECT max(created_at)::text AS latest FROM drizzle.__drizzle_migrations`,
    );
    return rows[0]?.latest ? Number(rows[0].latest) : null;
  } catch {
    // Database not reachable yet, or migrations (and their grants) not applied yet.
    return null;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Blocks until the database has this build's newest migration applied, so a pod never starts
 * against an older schema (first install, or an upgrade whose migration Job is still running).
 */
export async function waitForMigrations(options: WaitOptions): Promise<void> {
  const latest = latestMigration(options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER);
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  for (;;) {
    const applied = await appliedUpTo(options.databaseUrl);
    if (applied !== null && applied >= latest.when) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Migration ${latest.tag} is not applied after waiting; is the migration Job failing?`,
      );
    }
    await sleep(options.intervalMs ?? 2_000);
  }
}
