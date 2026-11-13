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
 * KOBE-380 (v1.3 Semantic Memory SMA5): the `memory_steward` site grant and the Workspace
 * `memory_stewards` team table arrive over a populated database at the previous migration. The
 * table is a team table under forced RLS with the canonical policy (the probe suite and the catalog
 * check cover it like every team table); a steward must be a member of that Workspace, and the
 * grant goes with the membership.
 */
const MARKER = 'CREATE TABLE "memory_stewards"';

let db: TestDatabase | undefined;
let older = "";
const teamA = randomUUID();
const teamB = randomUUID();
const ann = randomUUID();
const bob = randomUUID();

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().adminUrl, fn);
const asApp = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().appUrl, fn);

async function code(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Ann', $2), ($3, 'Bob', $4)`, [
      ann,
      `${ann}@example.test`,
      bob,
      `${bob}@example.test`,
    ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
      teamA,
      `a-${teamA.slice(0, 8)}`,
      teamB,
      `b-${teamB.slice(0, 8)}`,
    ]);
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, 'team_admin'), ($1, $3, 'contributor'), ($4, $3, 'member')`,
      [teamA, ann, bob, teamB],
    );
    await c.query(
      `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'skill_reviewer', $1)`,
      [ann],
    );
  });
  await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("memory stewards on upgrade (KOBE-380)", () => {
  it("adds memory_steward to site_grant and keeps existing grants (ac-4)", async () => {
    await asAdmin(async (c) => {
      const values = await c.query<{ v: string }>(
        `SELECT unnest(enum_range(NULL::site_grant))::text AS v`,
      );
      expect(values.rows.map((r) => r.v)).toEqual(["skill_reviewer", "memory_steward"]);
      const kept = await c.query(`SELECT user_id, "grant"::text FROM site_grants`);
      expect(kept.rows).toEqual([{ user_id: ann, grant: "skill_reviewer" }]);
      await c.query(
        `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'memory_steward', $2)`,
        [bob, ann],
      );
    });
  });

  it("creates memory_stewards empty, under forced RLS with the canonical policy (ac-4)", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query<{ rls: boolean; force: boolean; n: number }>(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                (SELECT count(*)::int FROM memory_stewards) AS n
           FROM pg_class c WHERE c.relname = 'memory_stewards'`,
      );
      expect(rows).toEqual([{ rls: true, force: true, n: 0 }]);
      const policies = await c.query<{ name: string; qual: string; check: string }>(
        `SELECT policyname AS name, qual, with_check AS check FROM pg_policies
          WHERE tablename = 'memory_stewards'`,
      );
      expect(policies.rows).toHaveLength(1);
      expect(policies.rows[0]?.name).toBe("team_isolation");
      expect(policies.rows[0]?.qual).toContain("current_setting('kobe.team_id'::text, true)");
      expect(policies.rows[0]?.check).toContain("current_setting('kobe.team_id'::text, true)");
      const notNull = await c.query<{ attname: string }>(
        `SELECT attname FROM pg_attribute WHERE attrelid = 'memory_stewards'::regclass
            AND attnum > 0 AND NOT attisdropped AND attnotnull ORDER BY attnum`,
      );
      expect(notNull.rows.map((r) => r.attname)).toEqual([
        "team_id",
        "user_id",
        "granted_by",
        "granted_at",
      ]);
    });
  });

  it("confines rows to the active Workspace for the app role (ac-4)", async () => {
    await asApp(async (c) => {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamA]);
      await c.query(
        `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
        [teamA, bob, ann],
      );
      // Writing another Workspace's row from team A is refused by the policy.
      expect(
        await code(() =>
          c.query(
            `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
            [teamB, bob, ann],
          ),
        ),
      ).toBe("42501");
      await c.query("COMMIT");
      await c.query("BEGIN");
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamB]);
      const seen = await c.query(`SELECT * FROM memory_stewards`);
      expect(seen.rows).toEqual([]);
      await c.query("COMMIT");
    });
  });

  it("needs a member of that Workspace and goes with the membership (ac-4)", async () => {
    await asAdmin(async (c) => {
      // Ann is not a member of team B.
      expect(
        await code(() =>
          c.query(
            `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
            [teamB, ann, bob],
          ),
        ),
      ).toBe("23503");
      await c.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [teamA, bob]);
      const left = await c.query(`SELECT * FROM memory_stewards WHERE team_id = $1`, [teamA]);
      expect(left.rows).toEqual([]);
    });
  });
});
