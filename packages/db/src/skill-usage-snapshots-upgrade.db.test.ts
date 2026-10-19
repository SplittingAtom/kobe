import { randomBytes, randomUUID } from "node:crypto";
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
 * KOBE-339 review M1 (0158): an install upgrades to `skill_usage_snapshots`; existing data is
 * untouched; the app role writes a window once and purges old ones, never rewrites one.
 */
const MARKER = `CREATE TABLE "skill_usage_snapshots"`;

let db: TestDatabase | undefined;
let oldMigrations = "";
const team = randomUUID();

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
  oldMigrations = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  await withClient(db.adminUrl, (c) =>
    c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
      team,
      `t-${randomBytes(4).toString("hex")}`,
    ]),
  );
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("skill_usage_snapshots (0158)", () => {
  it("keeps existing data; the app role inserts, reads and purges, never updates", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      expect((await c.query(`SELECT id FROM teams WHERE id = $1`, [team])).rows).toHaveLength(1);
    });
    await withClient(db.appUrl, async (c) => {
      await c.query(
        `INSERT INTO skill_usage_snapshots (window_start, window_end, payload)
         VALUES ('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', '{"skills": {}}')`,
      );
      expect((await c.query(`SELECT payload FROM skill_usage_snapshots`)).rows).toEqual([
        { payload: { skills: {} } },
      ]);
      await expect(c.query(`UPDATE skill_usage_snapshots SET payload = '{}'`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        c.query(
          `INSERT INTO skill_usage_snapshots (window_start, window_end, payload)
           VALUES ('2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z', '{}')`,
        ),
      ).rejects.toThrow(/skill_usage_snapshots_window/);
      await c.query(`DELETE FROM skill_usage_snapshots`);
    });
  });
});
