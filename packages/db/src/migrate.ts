import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { quoteIdent } from "./roles.js";
import { appPrivilegesFor } from "./tenancy.js";

/** Migrations ship next to dist/ and src/ alike (`packages/db/drizzle`). */
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export interface MigrateOptions {
  /** Connection as the schema owner role. Never the app role. */
  readonly databaseUrl: string;
  /** Login role the app uses; must not be superuser, BYPASSRLS, or own any table. */
  readonly appRole: string;
  readonly migrationsFolder?: string;
  /**
   * Called with every `RAISE NOTICE` a migration emits (upgrade notes, e.g. a dropped setting);
   * the migration Job logs them.
   */
  readonly onNotice?: (message: string) => void;
}

/** Serializes concurrent migration Jobs (e.g. overlapping Helm upgrades) and backups/restores. */
export const MIGRATION_LOCK_KEY = 0x6b6f6265; // "kobe"

interface RoleCheck {
  current_user: string;
  current_super: boolean;
  current_bypass: boolean;
  app_exists: boolean;
  app_super: boolean | null;
  app_bypass: boolean | null;
  app_owned: number;
  app_memberships: string[];
}

/** Checks both roles before any migration runs; FORCE RLS does not bind superusers or BYPASSRLS. */
async function verifyRoles(client: pg.ClientBase, appRole: string): Promise<void> {
  const { rows } = await client.query<RoleCheck>(
    `SELECT current_user,
            cur.rolsuper AS current_super, cur.rolbypassrls AS current_bypass,
            app.oid IS NOT NULL AS app_exists, app.rolsuper AS app_super, app.rolbypassrls AS app_bypass,
            (SELECT count(*)::int FROM pg_class c WHERE c.relowner = app.oid) AS app_owned,
            ARRAY(SELECT g.rolname::text FROM pg_roles g
                  WHERE app.oid IS NOT NULL AND g.oid <> app.oid AND pg_has_role(app.oid, g.oid, 'MEMBER')
                  ORDER BY 1) AS app_memberships
     FROM pg_roles cur LEFT JOIN pg_roles app ON app.rolname = $1
     WHERE cur.rolname = current_user`,
    [appRole],
  );
  const r = rows[0];
  if (!r) throw new Error("Refusing to migrate: could not read role information");
  const problems = [
    r.current_user === appRole ? "migrations must run as the owner role, not the app role" : null,
    r.current_super ? `migration role "${r.current_user}" is a superuser` : null,
    r.current_bypass ? `migration role "${r.current_user}" has BYPASSRLS` : null,
    r.app_exists ? null : `app role "${appRole}" does not exist`,
    r.app_super ? "app role is a superuser (bypasses RLS)" : null,
    r.app_bypass ? "app role has BYPASSRLS" : null,
    r.app_owned > 0 ? `app role owns ${r.app_owned} relations (owners can bypass RLS)` : null,
    r.app_memberships.length > 0
      ? `app role is a member of: ${r.app_memberships.join(", ")}`
      : null,
  ].filter((p): p is string => p !== null);
  if (problems.length > 0) throw new Error(`Refusing to migrate: ${problems.join("; ")}`);
}

/** Removes PUBLIC's ability to create objects, so the app role can't add views or functions. */
async function lockDownSchema(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ db: string }>(`SELECT current_database() AS db`);
  const db = rows[0]?.db ?? "";
  await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await client.query(
    `REVOKE CREATE, TEMPORARY ON DATABASE "${db.replaceAll('"', '""')}" FROM PUBLIC`,
  );
}

/** Resets the app role to exactly the grants matrix (tenancy.ts), in one transaction. */
async function grantAppPrivileges(client: pg.ClientBase, appRole: string): Promise<void> {
  const role = quoteIdent(appRole);
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
  );
  await client.query("BEGIN");
  try {
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    // Marker read by waiting pods (as the app role): which migration these grants belong to.
    // Written in this transaction, so pods never see new migrations before their grants.
    await client.query(
      `CREATE TABLE IF NOT EXISTS drizzle.kobe_grants_applied (migration_when bigint NOT NULL)`,
    );
    await client.query(`DELETE FROM drizzle.kobe_grants_applied`);
    await client.query(
      `INSERT INTO drizzle.kobe_grants_applied SELECT max(created_at) FROM drizzle.__drizzle_migrations`,
    );
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA drizzle TO ${role}`);
    await client.query(`GRANT SELECT ON drizzle.kobe_grants_applied TO ${role}`);
    for (const { name } of rows) {
      const privileges = appPrivilegesFor(name);
      if (privileges && privileges.length > 0) {
        await client.query(`GRANT ${privileges.join(", ")} ON ${quoteIdent(name)} TO ${role}`);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Verifies roles, applies pending migrations as the owner, locks down object creation, then resets
 * the app role's privileges to the grants matrix. Holds an advisory lock throughout.
 */
export async function runMigrations(options: MigrateOptions): Promise<void> {
  quoteIdent(options.appRole);
  // lock_timeout: a migration queued behind a long transaction would otherwise block live
  // traffic queued behind it; failing the Job is better. Migrations must be backward compatible
  // (expand/contract), since the previous release keeps serving during the upgrade hook.
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 2,
    connectionTimeoutMillis: 10_000,
    options: "-c lock_timeout=10s",
  });
  const { onNotice } = options;
  if (onNotice) {
    pool.on("connect", (client) => {
      client.on("notice", (notice) => onNotice(notice.message ?? ""));
    });
  }
  try {
    const client = await pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
      try {
        await verifyRoles(client, options.appRole);
        await migrate(drizzle({ client: pool }), {
          migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
        });
        await lockDownSchema(client);
        await grantAppPrivileges(client, options.appRole);
      } finally {
        await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
