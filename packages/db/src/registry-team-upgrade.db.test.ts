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
 * KOBE-330 review H1: a site that named an ordinary team as the Registry team migrates through
 * 0153 (`teams.registry`) and 0155 as the non-superuser owner. The designation is cleared (the
 * Registry is not ready) and the team is otherwise untouched; afterwards only a dedicated registry
 * team can be named, a team's flag never changes, and there is at most one registry team.
 */
const MARKER = 'ADD COLUMN "registry"';

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = { user: randomUUID(), team: randomUUID(), registry: randomUUID() };

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
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      ids.user,
      `u-${suffix}@example.test`,
    ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Finance')`, [
      ids.team,
      `fin-${suffix}`,
    ]);
    await c.query(`UPDATE site_skill_settings SET registry_team_id = $1 WHERE id = 1`, [ids.team]);
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("dedicated Registry team upgrade (KOBE-330 review)", () => {
  it("clears an ordinary team's designation and leaves the team alone", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const s = await c.query(`SELECT registry_team_id FROM site_skill_settings WHERE id = 1`);
      expect(s.rows).toEqual([{ registry_team_id: null }]);
      const t = await c.query(`SELECT name, registry FROM teams WHERE id = $1`, [ids.team]);
      expect(t.rows).toEqual([{ name: "Finance", registry: false }]);
    });
  });

  it("names only a registry team, keeps the flag fixed and allows one", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      await expect(
        c.query(`UPDATE site_skill_settings SET registry_team_id = $1 WHERE id = 1`, [ids.team]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        c.query(`UPDATE teams SET registry = true WHERE id = $1`, [ids.team]),
      ).rejects.toMatchObject({ code: "55000" });
      await c.query(
        `INSERT INTO teams (id, slug, name, registry) VALUES ($1, $2, 'Registry', true)`,
        [ids.registry, `reg-${suffix}`],
      );
      await c.query(`UPDATE site_skill_settings SET registry_team_id = $1 WHERE id = 1`, [
        ids.registry,
      ]);
      await expect(
        c.query(`INSERT INTO teams (slug, name, registry) VALUES ($1, 'Two', true)`, [
          `two-${suffix}`,
        ]),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        c.query(`UPDATE teams SET registry = false WHERE id = $1`, [ids.registry]),
      ).rejects.toMatchObject({ code: "55000" });
    });
  });
});
