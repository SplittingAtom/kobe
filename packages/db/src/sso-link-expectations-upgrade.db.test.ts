import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-630 (spec sso-oidc-scim §6, SSO-5): admin-expected links. `sso_link_expectations` arrives
 * empty over a populated database at the previous migration; it is site-wide (no RLS, no team_id),
 * one row per (provider, user), the expiry lies after the creation, and rows go with their
 * provider. The app role may insert, read and delete (single use).
 */
const MARKER = 'CREATE TABLE "sso_link_expectations"';
const TENANT = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

let db: TestDatabase | undefined;
let older = "";
const userId = randomUUID();
const adminId = randomUUID();
const providerId = randomUUID();

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const asApp = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().appUrl, fn);
const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().adminUrl, fn);

async function code(
  c: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  try {
    await c.query(sql, params);
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Ann', $2), ($3, 'Ada', $4)`, [
      userId,
      "ann@contoso.com",
      adminId,
      "ada@contoso.com",
    ]);
    await c.query(
      `INSERT INTO sso_providers (id, slug, display_name, kind, issuer, client_id, tenant_id,
         subject_claim, access_claim, managed_by, allowed_email_domains)
       VALUES ($1, 'corp', 'Contoso', 'entra', $2, 'app', $3, 'oid', 'roles', 'helm', '{contoso.com}')`,
      [providerId, `https://login.microsoftonline.com/${TENANT}/v2.0`, TENANT],
    );
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("sso_link_expectations on upgrade (KOBE-630)", () => {
  it("arrives empty and site-wide: no RLS, no team_id", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query<{ rls: boolean; n: number }>(
        `SELECT c.relrowsecurity AS rls,
                (SELECT count(*)::int FROM sso_link_expectations) AS n
           FROM pg_class c WHERE c.relname = 'sso_link_expectations'`,
      );
      expect(rows).toEqual([{ rls: false, n: 0 }]);
      const cols = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'sso_link_expectations' ORDER BY ordinal_position`,
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual([
        "provider_id",
        "user_id",
        "created_by",
        "created_at",
        "expires_at",
      ]);
    });
  });

  it("holds one expectation per provider and user, expiring after its creation", async () => {
    await asApp(async (c) => {
      const insert = `INSERT INTO sso_link_expectations (provider_id, user_id, created_by, expires_at)
                      VALUES ($1, $2, $3, $4)`;
      const later = new Date(Date.now() + 14 * 86_400_000);
      expect(await code(c, insert, [providerId, userId, adminId, later])).toBeUndefined();
      expect(await code(c, insert, [providerId, userId, adminId, later])).toBe("23505");
      expect(await code(c, insert, [providerId, adminId, adminId, new Date(0)])).toBe("23514");
      const gone = await c.query(
        `DELETE FROM sso_link_expectations WHERE provider_id = $1 AND user_id = $2 RETURNING 1`,
        [providerId, userId],
      );
      expect(gone.rowCount).toBe(1);
      expect(await code(c, insert, [providerId, userId, adminId, later])).toBeUndefined();
    });
  });

  it("goes with its provider", async () => {
    await asAdmin(async (c) => {
      await c.query(`DELETE FROM sso_providers WHERE id = $1`, [providerId]);
      const { rows } = await c.query(`SELECT 1 FROM sso_link_expectations`);
      expect(rows).toHaveLength(0);
    });
  });
});
