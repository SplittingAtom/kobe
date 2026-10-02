import { randomBytes } from "node:crypto";
import pg from "pg";
import { runMigrations } from "../migrate.js";

export interface TestDatabase {
  /** Superuser URL to the throwaway database (tests only). */
  readonly adminUrl: string;
  readonly ownerUrl: string;
  readonly ownerRole: string;
  readonly appUrl: string;
  readonly appRole: string;
  drop(): Promise<void>;
}

/**
 * Creates a throwaway database with a separate owner role (runs migrations) and app role
 * (NOSUPERUSER NOBYPASSRLS, owns nothing), migrated from scratch. `serverUrl` is a superuser URL
 * to a Postgres 17 server, used only to create and drop the database and roles.
 */
export async function createTestDatabase(serverUrl: string): Promise<TestDatabase> {
  const suffix = randomBytes(4).toString("hex");
  const dbName = `kobe_test_${suffix}`;
  const ownerRole = `kobe_owner_${suffix}`;
  const appRole = `kobe_app_${suffix}`;
  const password = randomBytes(16).toString("hex");
  const urlFor = (user: string): string => {
    const url = new URL(serverUrl);
    url.username = user;
    url.password = password;
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  const drop = async (): Promise<void> => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
    await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);
    await admin.end();
  };

  try {
    await admin.query(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`,
    );
    await admin.query(
      `CREATE ROLE ${appRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`,
    );
    await admin.query(`CREATE DATABASE ${dbName} OWNER ${ownerRole}`);
    await runMigrations({ databaseUrl: urlFor(ownerRole), appRole });
  } catch (err) {
    await drop();
    throw err;
  }

  const adminUrl = new URL(serverUrl);
  adminUrl.pathname = `/${dbName}`;
  return {
    adminUrl: adminUrl.toString(),
    ownerUrl: urlFor(ownerRole),
    ownerRole,
    appUrl: urlFor(appRole),
    appRole,
    drop,
  };
}

/** Reads KOBE_TEST_DATABASE_URL or fails with an explanation (db tests never silently skip). */
export function testServerUrl(): string {
  const url = process.env.KOBE_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "KOBE_TEST_DATABASE_URL is required for db tests: a superuser URL to a Postgres 17 server " +
        "(used only to create and drop a throwaway database and roles).",
    );
  }
  return url;
}
