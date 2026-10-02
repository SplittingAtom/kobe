import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { isRetryableConnectError } from "./connect-errors.js";
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

/** Newest entry by timestamp (drizzle applies entries newer than the last applied `when`). */
function latestMigration(folder: string): JournalEntry {
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as {
    entries: JournalEntry[];
  };
  const latest = journal.entries.reduce<JournalEntry | undefined>(
    (max, e) => (max === undefined || e.when > max.when ? e : max),
    undefined,
  );
  if (!latest) throw new Error(`No migrations in ${folder}`);
  return latest;
}

/** Marker table/schema missing or not yet granted: migrations simply haven't landed yet. */
const NOT_YET_SQLSTATES = new Set(["42P01", "3F000", "42501"]);

/**
 * Migration whose grants have been applied (written by the runner in the same transaction as the
 * app-role grants), or null while that isn't known yet. Non-transient errors (bad password,
 * missing database) throw, so a misconfigured pod fails fast instead of waiting out its timeout.
 */
async function grantsAppliedFor(databaseUrl: string): Promise<number | null> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ migration_when: string }>(
      `SELECT migration_when::text FROM drizzle.kobe_grants_applied`,
    );
    return rows[0] ? Number(rows[0].migration_when) : null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (isRetryableConnectError(err) || (code !== undefined && NOT_YET_SQLSTATES.has(code)))
      return null;
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Blocks until this build's newest migration is applied *and* the app role's grants for it are
 * committed, so a pod never starts against an older schema or before it can use new tables.
 */
export async function waitForMigrations(options: WaitOptions): Promise<void> {
  const latest = latestMigration(options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER);
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  for (;;) {
    const applied = await grantsAppliedFor(options.databaseUrl);
    if (applied !== null && applied >= latest.when) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Migration ${latest.tag} is not applied after waiting; is the migration Job failing?`,
      );
    }
    await sleep(options.intervalMs ?? 2_000);
  }
}
