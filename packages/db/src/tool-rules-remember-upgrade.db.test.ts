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
 * KOBE-289's backfill as an upgrade runs it: migrations run as the owner role (no superuser, no
 * BYPASSRLS) and `tool_rules` has FORCE ROW LEVEL SECURITY with no team set, so an UPDATE there
 * sees no rows unless the migration lifts FORCE for it. A site with a KOBE-37 user rule then
 * failed the new CHECK (gate1, 2026-10-17). The rules are written as the app writes them.
 */
const MARKER = "KOBE-289: remember scopes on user rules";

let db: TestDatabase | undefined;
let older = "";
const ids = { team: randomUUID(), user: randomUUID() };
const rules = {
  forever: randomUUID(),
  day: randomUUID(),
  month: randomUUID(),
  team: randomUUID(),
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

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Upgrade')`, [
      ids.team,
      `up-${ids.team.slice(0, 8)}`,
    ]);
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      ids.user,
      `${ids.user}@upgrade.test`,
    ]);
    await c.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [
      ids.team,
      ids.user,
    ]);
  });
  // KOBE-37 user rules (until revoked, 1 day, 30 days), inserted by the app role inside the team.
  await withClient(db.appUrl, async (c) => {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [ids.team]);
    for (const [id, expiry] of [
      [rules.forever, null],
      [rules.day, "1 day"],
      [rules.month, "30 days"],
    ] as const) {
      await c.query(
        `INSERT INTO tool_rules (id, team_id, scope, user_id, effect, tool_glob, created_by, expires_at)
         VALUES ($1, $2, 'user', $3, 'allow', 'bash', $3,
                 CASE WHEN $4::interval IS NULL THEN NULL ELSE now() + $4::interval END)`,
        [id, ids.team, ids.user, expiry],
      );
    }
    // A team rule: no remember scope, before the upgrade and after it.
    await c.query(
      `INSERT INTO tool_rules (id, team_id, scope, user_id, effect, tool_glob, created_by)
       VALUES ($1, $2, 'team', NULL, 'allow', 'bash', $3)`,
      [rules.team, ids.team, ids.user],
    );
    await c.query("COMMIT");
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("tool_rules remember scopes on upgrade (KOBE-289)", () => {
  it("backfills existing user rules as the non-superuser owner and keeps FORCE RLS", async () => {
    const { ownerUrl, appRole, adminUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await withClient(adminUrl, async (c) => {
      const res = await c.query<{ id: string; remember_scope: string | null }>(
        `SELECT id, remember_scope FROM tool_rules WHERE team_id = $1`,
        [ids.team],
      );
      expect(Object.fromEntries(res.rows.map((r) => [r.id, r.remember_scope]))).toEqual({
        [rules.forever]: "forever",
        [rules.day]: "day",
        [rules.month]: "month",
        [rules.team]: null,
      });
      const rls = await c.query<{ enabled: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
           FROM pg_class WHERE oid = 'public.tool_rules'::regclass`,
      );
      expect(rls.rows[0]).toEqual({ enabled: true, forced: true });
    });
  }, 120_000);
});
