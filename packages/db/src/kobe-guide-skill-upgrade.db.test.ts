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
 * KOBE-620's migration (0208) as an upgrade runs it, on a site where a maintainer's catalog skill
 * already took the new Kobe name `kobe-guide`: the upgrade never fails, that skill keeps its name
 * (the server's seed then skips Kobe's `kobe-guide` there, logged), and every other Kobe name
 * stays reserved as before.
 */
const MARKER = "'skill-creator', 'kobe-guide'";

let db: TestDatabase | undefined;
let older = "";

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};

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
    c.query(`INSERT INTO registry_skills (name, summary) VALUES ('kobe-guide', 'Ours.')`),
  );
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("kobe-guide on upgrade (KOBE-620)", () => {
  it("keeps a maintainer's kobe-guide, and the other Kobe names stay reserved", async () => {
    const { ownerUrl, appRole, adminUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await withClient(adminUrl, async (c) => {
      const kept = await c.query(
        `SELECT name, publisher::text FROM registry_skills WHERE name = 'kobe-guide'`,
      );
      expect(kept.rows).toEqual([{ name: "kobe-guide", publisher: "maintainer" }]);
      // The kept row can still change (its maintainers keep working on it).
      await c.query(`UPDATE registry_skills SET summary = 'Still ours.' WHERE name = 'kobe-guide'`);
      // Kobe cannot take it over (one name, one skill), nor publish under another name.
      await expect(
        c.query(
          `INSERT INTO registry_skills (name, summary, publisher) VALUES ('kobe-guide', 'K.', 'kobe')`,
        ),
      ).rejects.toMatchObject({ constraint: "registry_skills_name_unique" });
      await expect(
        c.query(
          `INSERT INTO registry_skills (name, summary, publisher) VALUES ('my-tool', 'K.', 'kobe')`,
        ),
      ).rejects.toMatchObject({ constraint: "registry_skills_kobe_names" });
      // The older Kobe names stay Kobe's.
      await expect(
        c.query(`INSERT INTO registry_skills (name, summary) VALUES ('xlsx', 'Mine.')`),
      ).rejects.toMatchObject({ constraint: "registry_skills_kobe_names" });
      // Without the clash, Kobe publishes kobe-guide.
      await c.query(`DELETE FROM registry_skills WHERE name = 'kobe-guide'`);
      await c.query(
        `INSERT INTO registry_skills (name, summary, publisher) VALUES ('kobe-guide', 'K.', 'kobe')`,
      );
    });
  }, 120_000);
});
