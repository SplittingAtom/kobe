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
 * KOBE-323: a site with threads migrates as the non-superuser owner; every existing thread reads
 * as an ordinary one (skill_test false, no draft), and RLS stays forced on threads.
 */
const MARKER = 'ADD COLUMN "skill_test"';

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = { user: randomUUID(), team: randomUUID(), threads: [randomUUID(), randomUUID()] };

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
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Bench')`, [
      ids.team,
      `bench-${suffix}`,
    ]);
    for (const id of ids.threads)
      await c.query(
        `INSERT INTO threads (team_id, id, owner_user_id, title, is_test) VALUES ($1, $2, $3, 'T', $4)`,
        [ids.team, id, ids.user, id === ids.threads[1]],
      );
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("thread skill_test upgrade (KOBE-323)", () => {
  it("reads every existing thread as an ordinary one, RLS still forced", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const rows = await c.query(
        `SELECT id, skill_test, skill_draft_id FROM threads WHERE team_id = $1 ORDER BY id`,
        [ids.team],
      );
      expect(rows.rows).toEqual(
        [...ids.threads].sort().map((id) => ({ id, skill_test: false, skill_draft_id: null })),
      );
      const rls = await c.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'threads'`,
      );
      expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    });
  });
});
