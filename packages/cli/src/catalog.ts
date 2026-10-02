import { quoteIdent } from "@kobe/db";
import type pg from "pg";
import type { MigrationRecord, UserTrigger } from "./restore-sql.js";

const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface TableInfo {
  readonly name: string;
  readonly forcedRls: boolean;
  /** The connected role owns the table (directly or through membership), or is superuser. */
  readonly ownedByCurrentUser: boolean;
}

/**
 * Ordinary tables in `public`, including partitions (pg_dump writes data per leaf table) and
 * excluding partitioned parents, which hold no rows of their own.
 */
export async function listTables(client: pg.ClientBase): Promise<TableInfo[]> {
  const { rows } = await client.query<{ name: string; forced: boolean; owned: boolean }>(
    `SELECT c.relname AS name, c.relforcerowsecurity AS forced,
            (pg_has_role(current_user, c.relowner, 'USAGE')
             OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)) AS owned
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       -- Extension-owned tables are recreated by CREATE EXTENSION, not dumped as data.
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
     ORDER BY c.relname`,
  );
  const unsupported = rows.filter((r) => !TABLE_NAME.test(r.name)).map((r) => r.name);
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported table names in public (use lowercase letters, digits and _): ${unsupported.map((n) => JSON.stringify(n)).join(", ")}`,
    );
  }
  return rows.map((r) => ({ name: r.name, forcedRls: r.forced, ownedByCurrentUser: r.owned }));
}

/** Applied Kobe migrations, oldest first; empty when the database was never migrated. */
export async function readJournal(client: pg.ClientBase): Promise<MigrationRecord[]> {
  const exists = await client.query<{ present: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  );
  if (!exists.rows[0]?.present) return [];
  const { rows } = await client.query<{ hash: string; created_at: string }>(
    `SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id`,
  );
  return rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }));
}

/** Foreign keys checked immediately (not DEFERRABLE) on public tables. */
export async function listImmediateForeignKeys(
  client: pg.ClientBase,
): Promise<{ table: string; constraint: string }[]> {
  const { rows } = await client.query<{ table: string; constraint: string }>(
    `SELECT c.relname AS table, con.conname AS constraint
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND con.contype = 'f'
       AND NOT con.condeferrable AND con.conparentid = 0
     ORDER BY c.relname, con.conname`,
  );
  return rows;
}

/** Enabled (origin or always) user triggers on public tables. */
export async function listUserTriggers(client: pg.ClientBase): Promise<UserTrigger[]> {
  const { rows } = await client.query<{ table: string; trigger: string; mode: "O" | "A" }>(
    `SELECT c.relname AS table, t.tgname AS trigger, t.tgenabled AS mode
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT t.tgisinternal
       AND t.tgenabled IN ('O', 'A')
     ORDER BY c.relname, t.tgname`,
  );
  return rows;
}

export interface ServerInfo {
  readonly user: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  readonly version: string;
  readonly major: number;
}

export async function serverInfo(client: pg.ClientBase): Promise<ServerInfo> {
  const { rows } = await client.query<{
    user: string;
    superuser: boolean;
    bypass: boolean;
    version: string;
    num: number;
  }>(
    `SELECT current_user AS user, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
            current_setting('server_version') AS version,
            current_setting('server_version_num')::int AS num
     FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const r = rows[0];
  if (!r) throw new Error("Could not read the connected role");
  return {
    user: r.user,
    superuser: r.superuser,
    bypassRls: r.bypass,
    version: r.version,
    major: Math.floor(r.num / 10_000),
  };
}

/**
 * Fails when data exists that a data-only dump of `public` would silently skip: tables, partitioned
 * tables, materialized views or foreign tables in any other schema (except Kobe's own migration
 * bookkeeping in `drizzle`), materialized views or foreign tables in `public`, and large objects.
 */
export async function assertCoverage(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ name: string; kind: string }>(
    `SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS kind
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'm', 'f')
       AND c.relpersistence <> 't'
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
       AND NOT (n.nspname = 'public' AND c.relkind IN ('r', 'p'))
       AND NOT (n.nspname = 'drizzle' AND c.relkind = 'r'
                AND c.relname IN ('__drizzle_migrations', 'kobe_grants_applied'))
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
     ORDER BY 1`,
  );
  const lo = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_largeobject_metadata`,
  );
  const problems = [
    ...rows.map(
      (r) =>
        `${r.name} (${{ r: "table", p: "table", m: "materialized view", f: "foreign table" }[r.kind] ?? r.kind})`,
    ),
    ...((lo.rows[0]?.n ?? 0) > 0 ? [`${lo.rows[0]?.n} large objects`] : []),
  ];
  if (problems.length > 0) {
    throw new Error(
      `Refusing to back up: data outside what a Kobe backup covers (tables in public) would be skipped: ${problems.join(", ")}`,
    );
  }
}

/** Distinct non-null object keys stored in the given blob-ref columns (in the current snapshot). */
export async function referencedObjectKeys(
  client: pg.ClientBase,
  columns: readonly { readonly table: string; readonly column: string }[],
): Promise<string[]> {
  const keys = new Set<string>();
  for (const ref of columns) {
    const col = quoteIdent(ref.column);
    const { rows } = await client.query<{ k: string }>(
      `SELECT DISTINCT ${col}::text AS k FROM public.${quoteIdent(ref.table)} WHERE ${col} IS NOT NULL`,
    );
    for (const r of rows) keys.add(r.k);
  }
  return [...keys];
}
