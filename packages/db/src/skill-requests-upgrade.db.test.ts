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
 * KOBE-338 review (0163–0165): an install with notifications upgrades. `team_skill_requests` is
 * created with forced row security (the app role sees only the team in force); an existing pause
 * notification keeps its shape; a skill notification names a catalog skill and nothing else.
 */
const MARKER = `CREATE TABLE "team_skill_requests"`;

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = {
  user: randomUUID(),
  teamA: randomUUID(),
  teamB: randomUUID(),
  skill: randomUUID(),
  paused: randomUUID(),
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

async function inTeam<T>(c: pg.Client, team: string, fn: () => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [team]);
    const out = await fn();
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
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
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
      ids.teamA,
      `a-${suffix}`,
      ids.teamB,
      `b-${suffix}`,
    ]);
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $3, 'member'),
         ($2, $3, 'member')`,
      [ids.teamA, ids.teamB, ids.user],
    );
    await c.query(`INSERT INTO registry_skills (id, name, summary) VALUES ($1, $2, 'S.')`, [
      ids.skill,
      `upgrade-${suffix}`,
    ]);
    await c.query(
      `INSERT INTO notifications (team_id, id, user_id, kind, paused_by)
       VALUES ($1, $2, $3, 'schedule.paused', 'team_admin')`,
      [ids.teamA, ids.paused, ids.user],
    );
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("team_skill_requests (0163, 0164)", () => {
  it("is a team table with forced row security", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const rls = await c.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'team_skill_requests'`,
      );
      expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    });
    await withClient(db.appUrl, async (c) => {
      for (const team of [ids.teamA, ids.teamB])
        await inTeam(c, team, () =>
          c.query(
            `INSERT INTO team_skill_requests (team_id, skill_id, user_id) VALUES ($1, $2, $3)`,
            [team, ids.skill, ids.user],
          ),
        );
      const seen = await inTeam(c, ids.teamA, () =>
        c.query<{ team_id: string }>(`SELECT team_id FROM team_skill_requests`),
      );
      expect(seen.rows).toEqual([{ team_id: ids.teamA }]);
      // Writing another team's row from team A's context is refused.
      await expect(
        inTeam(c, ids.teamA, () =>
          c.query(
            `INSERT INTO team_skill_requests (team_id, skill_id, user_id) VALUES ($1, $2, $3)`,
            [ids.teamB, ids.skill, randomUUID()],
          ),
        ),
      ).rejects.toThrow(/row-level security|violates/);
    });
  });
});

describe("skill notifications (0165)", () => {
  it("keeps the old pause and takes a skill notification with a skill only", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const old = await c.query(`SELECT kind, skill_id FROM notifications WHERE id = $1`, [
        ids.paused,
      ]);
      expect(old.rows).toEqual([{ kind: "schedule.paused", skill_id: null }]);
      const insert = (skill: string | null, pausedBy: string | null) =>
        c.query(
          `INSERT INTO notifications (team_id, id, user_id, kind, skill_id, paused_by)
           VALUES ($1, $2, $3, 'skill.member_add.blocked', $4, $5)`,
          [ids.teamA, randomUUID(), ids.user, skill, pausedBy],
        );
      await insert(ids.skill, null);
      await expect(insert(null, null)).rejects.toThrow(/notifications_shape/);
      await expect(insert(ids.skill, "team_admin")).rejects.toThrow(/notifications_shape/);
      // A pause naming a skill is refused too.
      await expect(
        c.query(
          `INSERT INTO notifications (team_id, id, user_id, kind, paused_by, skill_id)
           VALUES ($1, $2, $3, 'schedule.paused', 'team_admin', $4)`,
          [ids.teamA, randomUUID(), ids.user, ids.skill],
        ),
      ).rejects.toThrow(/notifications_shape/);
    });
  });
});
