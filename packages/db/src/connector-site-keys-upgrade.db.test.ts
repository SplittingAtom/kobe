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
 * KOBE-303's migration as an upgrade runs it (the owner role): connectors of every auth kind keep
 * working as per-member connectors (`credential_source = 'member'`), the app role can use
 * `connector_site_keys`, and a site key cannot be configured on a connector that is not `api_key`.
 */
const MARKER = 'CREATE TABLE "connector_site_keys"';

let db: TestDatabase | undefined;
let older = "";
const ids = { oauth: randomUUID(), apiKey: randomUUID(), none: randomUUID() };

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

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    for (const [id, kind] of [
      [ids.oauth, "oauth"],
      [ids.apiKey, "api_key"],
      [ids.none, "none"],
    ] as const) {
      await c.query(
        `INSERT INTO connectors (id, name, url, auth_kind) VALUES ($1, $2, 'https://x.example/mcp', $3)`,
        [id, `up-${kind.replace("_", "-")}`, kind],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("connector site keys on upgrade (KOBE-303)", () => {
  it("keeps every connector per-member and lets the app role store a site key", async () => {
    const { ownerUrl, appRole, adminUrl, appUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await withClient(adminUrl, async (c) => {
      const res = await c.query<{ id: string; credential_source: string }>(
        `SELECT id, credential_source FROM connectors`,
      );
      expect(new Set(res.rows.map((r) => r.credential_source))).toEqual(new Set(["member"]));
      await expect(
        c.query(`UPDATE connectors SET credential_source = 'site' WHERE id = $1`, [ids.oauth]),
      ).rejects.toThrow(/connectors_site_key_api_key/);
    });
    await withClient(appUrl, async (c) => {
      await c.query(`UPDATE connectors SET credential_source = 'site' WHERE id = $1`, [ids.apiKey]);
      await c.query(
        `INSERT INTO connector_site_keys (connector_id, sealed, key_id, url_sha256, hint)
         VALUES ($1, 'e1.k.x', 'k', repeat('a', 64), '••••')`,
        [ids.apiKey],
      );
      const { rows } = await c.query(`SELECT connector_id FROM connector_site_keys`);
      expect(rows).toEqual([{ connector_id: ids.apiKey }]);
    });
  }, 120_000);
});
