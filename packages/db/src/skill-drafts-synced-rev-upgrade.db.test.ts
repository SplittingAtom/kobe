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
 * KOBE-442 review H1/M2: a site whose drafts were saved from conversations (including two of one
 * name from one conversation, the KOBE-322 N2 race) migrates through 0158 (`synced_rev` and its partial unique index), 0159
 * (the backfill under NO FORCE/FORCE) as the non-superuser
 * owner. The newest draft per (team, author, conversation, name) becomes the save target at its
 * revision, the others are left as they were, other drafts are untouched, FORCE is back on, and a
 * second save target of the same name is refused.
 */
const MARKER = 'ADD COLUMN "synced_rev"';

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = {
  user: randomUUID(),
  team: randomUUID(),
  thread: randomUUID(),
  older: randomUUID(),
  newer: randomUUID(),
  other: randomUUID(),
  blank: randomUUID(),
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

const draft = (
  c: pg.Client,
  id: string,
  name: string,
  thread: string | null,
  at: string,
  rev = 1,
) =>
  c.query(
    `INSERT INTO skill_drafts (team_id, id, owner_user_id, name, started_from, from_thread_id, rev,
                               updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $3)`,
    [ids.team, id, ids.user, name, thread ? "thread" : "blank", thread, rev, at],
  );

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
    await c.query("BEGIN");
    await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [ids.team]);
    await draft(c, ids.older, "close-helper", ids.thread, "2026-10-01T10:00:00Z", 2);
    await draft(c, ids.newer, "close-helper", ids.thread, "2026-10-02T10:00:00Z", 5);
    await draft(c, ids.other, "other-skill", ids.thread, "2026-10-01T10:00:00Z", 3);
    await draft(c, ids.blank, "blank-one", null, "2026-10-01T10:00:00Z", 4);
    await c.query("COMMIT");
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("skill_drafts synced_rev upgrade (KOBE-442)", () => {
  it("makes the newest draft per conversation and name the save target, at its revision", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const rows = await c.query<{ id: string; synced_rev: number | null; rev: number }>(
        `SELECT id, synced_rev, rev FROM skill_drafts WHERE team_id = $1`,
        [ids.team],
      );
      const by = new Map(rows.rows.map((r) => [r.id, r]));
      expect(by.get(ids.newer)).toMatchObject({ synced_rev: 5, rev: 5 });
      expect(by.get(ids.older)).toMatchObject({ synced_rev: null, rev: 2 });
      expect(by.get(ids.other)).toMatchObject({ synced_rev: 3 });
      expect(by.get(ids.blank)).toMatchObject({ synced_rev: null, rev: 4 });
      const rls = await c.query<{ relforcerowsecurity: boolean }>(
        `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'skill_drafts'`,
      );
      expect(rls.rows).toEqual([{ relforcerowsecurity: true }]);
    });
  });

  it("refuses a second save target of one name from one conversation", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [ids.team]);
      await expect(
        c.query(`UPDATE skill_drafts SET synced_rev = rev WHERE team_id = $1 AND id = $2`, [
          ids.team,
          ids.older,
        ]),
      ).rejects.toMatchObject({ code: "23505" });
      await c.query("ROLLBACK");
    });
  });
});
