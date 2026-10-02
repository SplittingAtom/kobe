import { quoteIdent } from "@kobe/db";

export interface MigrationRecord {
  readonly hash: string;
  readonly createdAt: number;
}

export interface UserTrigger {
  readonly table: string;
  readonly trigger: string;
  /** pg_trigger.tgenabled: O fires in origin mode, A always. */
  readonly mode: "O" | "A";
}

/** Everything the restore transaction needs, read from the manifest and the target catalog. */
export interface RestorePlan {
  readonly lockKey: number;
  readonly migrations: readonly MigrationRecord[];
  /** Every table in `public`: locked for the whole transaction. */
  readonly lockTables: readonly string[];
  /** Tables whose rows the dump loads, with the expected row count. */
  readonly loadTables: readonly { readonly name: string; readonly rows: number }[];
  /** Tables with FORCE ROW LEVEL SECURITY, lifted for the owner during the load only. */
  readonly forcedRls: readonly string[];
  /** Enabled user triggers, disabled during the load (pg_restore --disable-triggers semantics). */
  readonly userTriggers: readonly UserTrigger[];
}

const table = (name: string): string => `public.${quoteIdent(name)}`;
/** Any identifier read from the catalog (trigger names are not restricted like table names). */
const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** Canonical text of the journal, compared inside the transaction. */
export function journalText(migrations: readonly MigrationRecord[]): string {
  return migrations.map((m) => `${m.hash}:${m.createdAt}`).join(",");
}

function doBlock(body: string): string {
  return `DO $kobe$\n${body}\n$kobe$;`;
}

/**
 * SQL sent before the pg_restore data script, in the same psql session. The whole restore is one
 * transaction: on any error (or a dropped connection) nothing is kept, including the RLS changes.
 */
export function restorePrelude(plan: RestorePlan): string {
  const lockKey = Math.trunc(plan.lockKey);
  const nonEmptyChecks = plan.loadTables
    .map(
      (t) =>
        `  IF EXISTS (SELECT 1 FROM ${table(t.name)}) THEN found := found || ' ' || ${literal(t.name)}; END IF;`,
    )
    .join("\n");
  return [
    "BEGIN;",
    "SET LOCAL lock_timeout = '10s';",
    // Excludes migration Jobs, backups and other restores for the whole transaction.
    doBlock(
      `BEGIN\n  IF NOT pg_try_advisory_xact_lock(${lockKey}) THEN\n    RAISE EXCEPTION 'kobe restore: a migration, backup or restore is running; try again when it finishes';\n  END IF;\nEND`,
    ),
    plan.lockTables.length > 0
      ? `LOCK TABLE ${plan.lockTables.map(table).join(", ")} IN ACCESS EXCLUSIVE MODE;`
      : "",
    // NO FORCE exempts only the table owner (this session); the app role stays bound by RLS, and
    // the change is rolled back with everything else if the restore fails.
    ...plan.forcedRls.map((t) => `ALTER TABLE ${table(t)} NO FORCE ROW LEVEL SECURITY;`),
    ...plan.userTriggers.map(
      (t) => `ALTER TABLE ${table(t.table)} DISABLE TRIGGER ${ident(t.trigger)};`,
    ),
    doBlock(
      `BEGIN\n  IF (SELECT coalesce(string_agg(hash || ':' || created_at, ',' ORDER BY created_at, id), '') FROM drizzle.__drizzle_migrations) <> ${literal(journalText(plan.migrations))} THEN\n    RAISE EXCEPTION 'kobe restore: the database''s applied migrations do not match the backup; nothing was restored';\n  END IF;\nEND`,
    ),
    // After NO FORCE, so team rows are visible to this check (a FORCE'd table looks empty).
    doBlock(
      `DECLARE found text := '';\nBEGIN\n${nonEmptyChecks}\n  IF found <> '' THEN\n    RAISE EXCEPTION 'kobe restore: the target already has data in:%; restore only into a freshly installed Kobe. Nothing was restored', found;\n  END IF;\nEND`,
    ),
    "",
  ]
    .filter((line, i, all) => line !== "" || i === all.length - 1)
    .join("\n");
}

/** SQL sent after the data script: verify, restore triggers and FORCE RLS, commit. */
export function restorePostlude(plan: RestorePlan): string {
  const countChecks = plan.loadTables
    .map(
      (t) =>
        `  SELECT count(*) INTO n FROM ${table(t.name)};\n  IF n <> ${Math.trunc(t.rows)} THEN RAISE EXCEPTION 'kobe restore: % has % rows, the backup has ${Math.trunc(t.rows)}; nothing was restored', ${literal(t.name)}, n; END IF;`,
    )
    .join("\n");
  const enable = (t: UserTrigger): string =>
    `ALTER TABLE ${table(t.table)} ENABLE ${t.mode === "A" ? "ALWAYS " : ""}TRIGGER ${ident(t.trigger)};`;
  return [
    "",
    doBlock(`DECLARE n bigint;\nBEGIN\n${countChecks}\nEND`),
    ...plan.userTriggers.map(enable),
    ...plan.forcedRls.map((t) => `ALTER TABLE ${table(t)} FORCE ROW LEVEL SECURITY;`),
    "COMMIT;",
    "",
  ].join("\n");
}
