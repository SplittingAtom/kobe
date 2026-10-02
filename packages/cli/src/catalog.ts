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
