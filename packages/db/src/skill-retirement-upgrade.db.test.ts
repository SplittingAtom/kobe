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
 * KOBE-340 (0153, regenerated with the rest of Phase C): an install with notifications upgrades;
 * a pause keeps its shape; a retirement notice names its skill, and a version one its version.
 */
const MARKER = `ADD COLUMN "skill_semver"`;

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = { user: randomUUID(), team: randomUUID(), skill: randomUUID(), old: randomUUID() };

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
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
      ids.team,
      `t-${suffix}`,
    ]);
    await c.query(`INSERT INTO registry_skills (id, name, summary) VALUES ($1, $2, 'S.')`, [
      ids.skill,
      `retire-${suffix}`,
    ]);
    await c.query(
      `INSERT INTO notifications (team_id, id, user_id, kind, paused_by)
       VALUES ($1, $2, $3, 'schedule.paused', 'team_admin')`,
      [ids.team, ids.old, ids.user],
    );
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("retirement notifications (0167)", () => {
  it("keeps the pause and takes retirement notices with their skill and version", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const old = await c.query(`SELECT kind, skill_semver FROM notifications WHERE id = $1`, [
        ids.old,
      ]);
      expect(old.rows).toEqual([{ kind: "schedule.paused", skill_semver: null }]);
      const insert = (kind: string, semver: string | null) =>
        c.query(
          `INSERT INTO notifications (team_id, id, user_id, kind, skill_id, skill_semver)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [ids.team, randomUUID(), ids.user, kind, ids.skill, semver],
        );
      await insert("skill.version.revoked", "1.2.0");
      await insert("skill.deprecated", null);
      await expect(insert("skill.version.withdrawn", null)).rejects.toThrow(/notifications_shape/);
      await expect(insert("skill.deprecated", "1.0.0")).rejects.toThrow(/notifications_shape/);
      await expect(insert("skill.member_add.blocked", "1.0.0")).rejects.toThrow(
        /notifications_shape/,
      );
      await expect(insert("skill.version.other", "1.0.0")).rejects.toThrow(/notifications_kind/);
    });
  });
});
