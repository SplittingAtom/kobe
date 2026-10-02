import { randomBytes } from "node:crypto";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../migrate.js";

declare module "vitest" {
  export interface ProvidedContext {
    adminUrl: string;
    ownerUrl: string;
    ownerRole: string;
    appUrl: string;
    appRole: string;
  }
}

/**
 * Creates a throwaway database with a separate owner role (runs migrations) and app role
 * (NOSUPERUSER NOBYPASSRLS, owns nothing), migrates it from scratch, and drops it afterwards.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = process.env.KOBE_TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "KOBE_TEST_DATABASE_URL is required for db tests: a superuser URL to a Postgres 17 server " +
        "(used only to create and drop a throwaway database and roles).",
    );
  }

  const suffix = randomBytes(4).toString("hex");
  const dbName = `kobe_test_${suffix}`;
  const ownerRole = `kobe_owner_${suffix}`;
  const appRole = `kobe_app_${suffix}`;
  const password = randomBytes(16).toString("hex");
  const urlFor = (user: string): string => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const teardown = async (): Promise<void> => {
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
    await teardown();
    throw err;
  }

  const adminDbUrl = new URL(adminUrl);
  adminDbUrl.pathname = `/${dbName}`;
  project.provide("adminUrl", adminDbUrl.toString());
  project.provide("ownerUrl", urlFor(ownerRole));
  project.provide("ownerRole", ownerRole);
  project.provide("appUrl", urlFor(appRole));
  project.provide("appRole", appRole);

  return teardown;
}
