import { quoteIdent } from "@kobe/db";
import { isSeeded } from "./seeded.js";

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
  /**
   * Non-deferrable foreign keys, made DEFERRABLE INITIALLY DEFERRED for the load (data-only loads
   * cannot order around FK cycles such as threads ⇄ thread_entries) and restored before COMMIT.
   */
  readonly immediateForeignKeys: readonly { readonly table: string; readonly constraint: string }[];
  /**
   * Recorded as `platform.restore.completed` in the restored audit log (KOBE-15), inside the
   * restore transaction after the triggers are back, so it extends the restored hash chain.
   */
  readonly audit?: RestoreAudit;
}

/** An audit chain head the restored chain must contain (or, with `exact`, end at). */
export interface ExpectedAuditHead {
  /** 0 with a null hash: the chain must be empty. */
  readonly seq: number;
  readonly hash: string | null;
  readonly exact: boolean;
  /** Where the expectation comes from, for the error message. */
  readonly source: string;
}

export interface RestoreAudit {
  readonly backupCreatedAt: string;
  readonly tables: number;
  readonly rows: number;
  /** Who ran the restore (OS user or --operator). */
  readonly operator: string;
  readonly expectHeads: readonly ExpectedAuditHead[];
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
    .filter((t) => !isSeeded(t.name))
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
    ...plan.immediateForeignKeys.map(
      (f) =>
        `ALTER TABLE ${table(f.table)} ALTER CONSTRAINT ${ident(f.constraint)} DEFERRABLE INITIALLY DEFERRED;`,
    ),
    "SET CONSTRAINTS ALL DEFERRED;",
    doBlock(
      `BEGIN\n  IF (SELECT coalesce(string_agg(hash || ':' || created_at, ',' ORDER BY created_at, id), '') FROM drizzle.__drizzle_migrations) <> ${literal(journalText(plan.migrations))} THEN\n    RAISE EXCEPTION 'kobe restore: the database''s applied migrations do not match the backup; nothing was restored';\n  END IF;\nEND`,
    ),
    // After NO FORCE, so team rows are visible to this check (a FORCE'd table looks empty).
    doBlock(
      `DECLARE found text := '';\nBEGIN\n${nonEmptyChecks}\n  IF found <> '' THEN\n    RAISE EXCEPTION 'kobe restore: the target already has data in:%; restore only into a freshly installed Kobe. Nothing was restored', found;\n  END IF;\nEND`,
    ),
    // Rows a migration seeded on the fresh target give way to the backup's (seeded.ts).
    ...plan.loadTables.filter((t) => isSeeded(t.name)).map((t) => `DELETE FROM ${table(t.name)};`),
    "",
  ]
    .filter((line, i, all) => line !== "" || i === all.length - 1)
    .join("\n");
}

const OPERATOR = /^[A-Za-z0-9._@-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;

function expectHeadCheck(head: ExpectedAuditHead): string {
  const seq = Math.trunc(head.seq);
  if (head.hash !== null && !HASH.test(head.hash)) throw new Error("invalid audit head hash");
  const what = `${seq}:${head.hash ?? "(empty)"}`;
  const ok =
    head.hash === null
      ? `head_seq = ${seq}`
      : head.exact
        ? `head_seq = ${seq} AND head_hash = ${literal(head.hash)}`
        : `EXISTS (SELECT 1 FROM public.audit_log WHERE seq = ${seq} AND hash = ${literal(head.hash)})`;
  const want = head.exact ? "end at" : "contain";
  return `  IF NOT (${ok}) THEN
    RAISE EXCEPTION 'kobe restore: the restored audit chain does not ${want} ${what} (${head.source.replace(/[^A-Za-z0-9 :-]/g, "")}); its head is %:%. Nothing was restored', head_seq, coalesce(head_hash, '(empty)');
  END IF;`;
}

/**
 * Verifies the restored audit hash chain (KOBE-15; v2 with erasable IP and user agent, KOBE-17)
 * inside the restore transaction with the release's own check, `audit_log_chain_problem()` (the
 * migration journal matches the backup, so the function is this release's), and fails the whole
 * restore on any break or unexpected head; then appends `platform.restore.completed` (append
 * trigger assigns seq and hashes) so the chain continues past the restored rows.
 */
function auditRestore(audit: RestoreAudit): string {
  if (!OPERATOR.test(audit.operator)) throw new Error("invalid operator name");
  const target = (headSeq: string, headHash: string) =>
    `jsonb_strip_nulls(jsonb_build_object('backupCreatedAt', ${literal(
      new Date(audit.backupCreatedAt).toISOString(),
    )}, 'tables', ${Math.trunc(audit.tables)}, 'rows', ${Math.trunc(audit.rows)}, 'operator', ${literal(
      audit.operator,
    )}, 'auditHeadSeq', NULLIF(${headSeq}, 0), 'auditHeadHash', ${headHash}))`;
  return doBlock(
    [
      "DECLARE",
      "  c record;",
      "  head_seq bigint;",
      "  head_hash text;",
      "BEGIN",
      "  IF to_regclass('public.audit_log') IS NULL THEN RETURN; END IF;",
      "  SELECT * INTO c FROM public.audit_log_chain_problem();",
      "  IF c.problem IS NOT NULL THEN",
      "    RAISE EXCEPTION 'kobe restore: the audit chain in the backup is broken at seq % (%); nothing was restored', c.problem_seq, c.problem;",
      "  END IF;",
      "  head_seq := c.head_seq;",
      "  head_hash := c.head_hash;",
      ...audit.expectHeads.map(expectHeadCheck),
      "  INSERT INTO public.audit_log (actor_kind, action, target)",
      `    VALUES ('system', 'platform.restore.completed', ${target("head_seq", "head_hash")});`,
      "END",
    ].join("\n"),
  );
}

/** SQL sent after the data script: verify, restore triggers and FORCE RLS, record, commit. */
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
    // Checks every deferred foreign key now (a violation aborts), then restores them as they were.
    "SET CONSTRAINTS ALL IMMEDIATE;",
    ...plan.immediateForeignKeys.map(
      (f) =>
        `ALTER TABLE ${table(f.table)} ALTER CONSTRAINT ${ident(f.constraint)} NOT DEFERRABLE INITIALLY IMMEDIATE;`,
    ),
    ...plan.userTriggers.map(enable),
    ...plan.forcedRls.map((t) => `ALTER TABLE ${table(t)} FORCE ROW LEVEL SECURITY;`),
    plan.audit ? auditRestore(plan.audit) : "",
    // KOBE-17: legal holds are as of the backup; pause the audit IP erasure for 24 h so install
    // admins can re-place holds placed after it before any value they would keep is erased.
    "INSERT INTO public.install_settings (key, value) VALUES ('audit.pii_sweep_resume_at', to_char((now() + interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();",
    "COMMIT;",
    "",
  ].join("\n");
}
