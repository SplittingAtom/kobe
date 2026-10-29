import { createHash, randomUUID } from "node:crypto";
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
 * KOBE-497 (0182) as an upgrade runs it: an existing site with users and settings gains an empty
 * `site_branding_assets`, which the app role can write under the grants matrix.
 */
const MARKER = 'CREATE TABLE "site_branding_assets"';

let db: TestDatabase | undefined;
let older = "";
const userId = randomUUID();

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      userId,
      `${userId}@u.test`,
    ]);
    await c.query(`INSERT INTO site_settings (key, value) VALUES ('branding.app_name', 'Acme')`);
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("site branding assets on upgrade (KOBE-497)", () => {
  it("adds an empty table the app role can write, keeping existing settings", async () => {
    if (!db) throw new Error("database not created");
    await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
    await withClient(db.appUrl, async (c) => {
      expect((await c.query(`SELECT 1 FROM site_branding_assets`)).rowCount).toBe(0);
      const bytes = Buffer.from("<svg/>");
      const sha = createHash("sha256").update(bytes).digest("hex");
      await c.query(
        `INSERT INTO site_branding_assets (kind, bytes, content_type, sha256, byte_size, updated_by)
         VALUES ('logo', $1, 'image/svg+xml', $2, $3, $4)`,
        [bytes, sha, bytes.length, userId],
      );
      await c.query(`DELETE FROM site_branding_assets WHERE kind = 'logo'`);
      const { rows } = await c.query(
        `SELECT value FROM site_settings WHERE key = 'branding.app_name'`,
      );
      expect(rows).toEqual([{ value: "Acme" }]);
    });
  }, 120_000);
});
