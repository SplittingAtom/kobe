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

/** KOBE-340 (0158): review events upgrade; an undo of a deprecation is a review event. */
const MARKER = `ADD VALUE 'undeprecated'`;

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = { user: randomUUID(), skill: randomUUID(), version: randomUUID() };

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const event = (c: pg.Client, action: string) =>
  c.query(
    `INSERT INTO registry_review_events (version_id, actor_id, action)
     VALUES ($1, $2, $3::registry_review_action)`,
    [ids.version, ids.user, action],
  );

beforeAll(async () => {
  oldMigrations = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      ids.user,
      `u-${suffix}@example.test`,
    ]);
    await c.query(`INSERT INTO registry_skills (id, name, summary) VALUES ($1, $2, 'S.')`, [
      ids.skill,
      `undo-${suffix}`,
    ]);
    await c.query(
      `INSERT INTO registry_versions (id, skill_id, semver, seq, runtime_hash, package_hash,
         manifest, provenance, source, scan, verdict, state, submitted_by)
       VALUES ($1, $2, '1.0.0', 1, repeat('a', 64), repeat('b', 64), '{}', '{}', '{}', '{}',
         'pass', 'submitted', $3)`,
      [ids.version, ids.skill, ids.user],
    );
    await event(c, "deprecated");
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("undeprecated (0158)", () => {
  it("keeps the old events and records an undo", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      await event(c, "undeprecated");
      const rows = await c.query(
        `SELECT action::text FROM registry_review_events WHERE version_id = $1 ORDER BY id`,
        [ids.version],
      );
      expect(rows.rows.map((r) => r.action)).toEqual(["deprecated", "undeprecated"]);
    });
  });
});
