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
 * KOBE-638: a Site admin adds members from the Site console. `team_members.added_via` takes
 * `site_admin`, and `notifications` takes `team.member.added` (the admin in `actor_user_id`, no
 * schedule, thread, run or skill). Upgrade over a populated database at the previous migration.
 */
const MARKER = "'team.member.added'";

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const userId = randomUUID();
const adminId = randomUUID();

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => {
  if (!db) throw new Error("database not created");
  return withClient(db.adminUrl, fn);
};

async function code(c: pg.Client, sql: string, params: unknown[]): Promise<string | undefined> {
  try {
    await c.query(sql, params);
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(async (c) => {
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'ops', 'Ops')`, [teamId]);
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Ann', $2), ($3, 'Ada', $4)`, [
      userId,
      `${userId}@upgrade.test`,
      adminId,
      `${adminId}@upgrade.test`,
    ]);
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role, added_via)
       VALUES ($1, $2, 'member', 'skill_reviewer_grant')`,
      [teamId, userId],
    );
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("site-admin memberships on upgrade (KOBE-638)", () => {
  it("keeps existing rows and accepts site_admin, nothing else new", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query(`SELECT added_via FROM team_members WHERE team_id = $1`, [
        teamId,
      ]);
      expect(rows).toEqual([{ added_via: "skill_reviewer_grant" }]);
      const set = `UPDATE team_members SET added_via = $2 WHERE user_id = $1`;
      expect(await code(c, set, [userId, "site_admin"])).toBeUndefined();
      expect(await code(c, set, [userId, "site_console"])).toBe("23514");
    });
  });

  it("takes a team.member.added notification naming the admin and nothing else", async () => {
    await asAdmin(async (c) => {
      const insert = `INSERT INTO notifications (team_id, user_id, kind, actor_user_id, schedule_id)
        VALUES ($1, $2, 'team.member.added', $3, $4)`;
      expect(await code(c, insert, [teamId, userId, adminId, null])).toBeUndefined();
      expect(await code(c, insert, [teamId, userId, null, null])).toBe("23514");
      expect(await code(c, insert, [teamId, userId, adminId, randomUUID()])).toBe("23514");
    });
  });
});
