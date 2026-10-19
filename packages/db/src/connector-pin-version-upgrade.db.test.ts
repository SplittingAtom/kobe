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
 * KOBE-433 re-review (0156) as an upgrade runs it: every existing connector is a legacy pin
 * (`pin_version` 1, which may adopt a template reference once) with no template skip recorded.
 */
const MARKER = 'ADD COLUMN "pin_version"';

let db: TestDatabase | undefined;
let older = "";
const id = randomUUID();

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
  await withClient(db.adminUrl, (c) =>
    c.query(
      `INSERT INTO connectors (id, name, url, tools_hash) VALUES ($1, 'legacy', 'https://x.example/mcp', repeat('a', 64))`,
      [id],
    ),
  );
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("connector pin version on upgrade (KOBE-433)", () => {
  it("marks existing connectors as legacy pins and checks the new columns", async () => {
    if (!db) throw new Error("database not created");
    await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
    await withClient(db.appUrl, async (c) => {
      const { rows } = await c.query(
        `SELECT pin_version, templates_skipped FROM connectors WHERE id = $1`,
        [id],
      );
      expect(rows).toEqual([{ pin_version: 1, templates_skipped: null }]);
      await c.query(
        `UPDATE connectors SET pin_version = 2, templates_skipped = 'proxy_outdated' WHERE id = $1`,
        [id],
      );
      await expect(
        c.query(`UPDATE connectors SET pin_version = 3 WHERE id = $1`, [id]),
      ).rejects.toThrow(/connectors_pin_version/);
      await expect(
        c.query(`UPDATE connectors SET templates_skipped = 'Bad Reason' WHERE id = $1`, [id]),
      ).rejects.toThrow(/connectors_templates_skipped/);
    });
  }, 120_000);
});
