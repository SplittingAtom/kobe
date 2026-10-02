import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { quoteIdent } from "./roles.js";

/** Migrations ship next to dist/ and src/ alike (`packages/db/drizzle`). */
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export interface MigrateOptions {
  /** Connection as the schema owner role. Never the app role. */
  readonly databaseUrl: string;
  /** Login role the app uses; must not be superuser, BYPASSRLS, or own any table. */
  readonly appRole: string;
  readonly migrationsFolder?: string;
}

interface RoleRow {
  current_user: string;
  rolsuper: boolean | null;
  rolbypassrls: boolean | null;
  owned: number;
}

async function verifyAppRole(client: pg.ClientBase, appRole: string): Promise<void> {
  const { rows } = await client.query<RoleRow>(
    `SELECT current_user, r.rolsuper, r.rolbypassrls,
            (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
     FROM (SELECT 1) one LEFT JOIN pg_roles r ON r.rolname = $1`,
    [appRole],
  );
  const role = rows[0];
  const problems = [
    role?.rolsuper === null || role === undefined ? `role "${appRole}" does not exist` : null,
    role?.current_user === appRole
      ? "migrations must run as the owner role, not the app role"
      : null,
    role?.rolsuper ? "app role is a superuser (bypasses RLS)" : null,
    role?.rolbypassrls ? "app role has BYPASSRLS" : null,
    role && role.owned > 0 ? `app role owns ${role.owned} relations (owners can bypass RLS)` : null,
  ].filter((p): p is string => p !== null);
  if (problems.length > 0) throw new Error(`Refusing to migrate: ${problems.join("; ")}`);
}

async function grantAppPrivileges(client: pg.ClientBase, appRole: string): Promise<void> {
  const role = quoteIdent(appRole);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
  );
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
}

/** Applies pending migrations as the owner, then (re)grants the app role its privileges. */
export async function runMigrations(options: MigrateOptions): Promise<void> {
  quoteIdent(options.appRole);
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
    });
    const client = await pool.connect();
    try {
      await verifyAppRole(client, options.appRole);
      await grantAppPrivileges(client, options.appRole);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
