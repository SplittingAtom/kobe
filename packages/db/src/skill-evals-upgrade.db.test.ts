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
 * KOBE-325: a site with threads and live sandbox connections migrates as the non-superuser owner;
 * every existing thread reads as an ordinary one, every connection, command and lease as the
 * member's own sandbox (slot ''), and RLS stays forced.
 */
const MARKER = 'ADD COLUMN "skill_eval"';

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = { user: randomUUID(), team: randomUUID(), thread: randomUUID(), sandbox: randomUUID() };

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
      `evu-${suffix}`,
    ]);
    await c.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 'T')`,
      [ids.team, ids.thread, ids.user],
    );
    await c.query(
      `INSERT INTO sandbox_connections (team_id, user_id, sandbox_id, connection_id, replica_id)
       VALUES ($1, $2, $3, $4, 'r1')`,
      [ids.team, ids.user, ids.sandbox, randomUUID()],
    );
    await c.query(
      `INSERT INTO sandbox_commands (team_id, user_id, thread_id, kind, frame, requester_replica, expires_at)
       VALUES ($1, $2, $3, 'run.stop', '{}', 'r1', now() + interval '1 minute')`,
      [ids.team, ids.user, ids.thread],
    );
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("skill eval upgrade (KOBE-325)", () => {
  it("reads existing threads as ordinary and existing wire rows as the member's own sandbox", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const t = await c.query(`SELECT skill_eval, skill_eval_run_id FROM threads WHERE id = $1`, [
        ids.thread,
      ]);
      expect(t.rows).toEqual([{ skill_eval: false, skill_eval_run_id: null }]);
      const conn = await c.query(`SELECT slot FROM sandbox_connections WHERE user_id = $1`, [
        ids.user,
      ]);
      expect(conn.rows).toEqual([{ slot: "" }]);
      const cmd = await c.query(`SELECT slot FROM sandbox_commands WHERE user_id = $1`, [ids.user]);
      expect(cmd.rows).toEqual([{ slot: "" }]);
      const rls = await c.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('threads', 'sandbox_connections', 'skill_eval_runs', 'skill_eval_results')
          ORDER BY relname`,
      );
      expect(rls.rows.map((r: { relforcerowsecurity: boolean }) => r.relforcerowsecurity)).toEqual([
        true,
        true,
        true,
        true,
      ]);
      // The connection's key is still one row per (team, user) for the member's own sandbox.
      const dup = await c
        .query(
          `INSERT INTO sandbox_connections (team_id, user_id, sandbox_id, connection_id, replica_id)
           VALUES ($1, $2, $3, $4, 'r2')`,
          [ids.team, ids.user, randomUUID(), randomUUID()],
        )
        .then(
          () => undefined,
          (e: { code?: string }) => e.code,
        );
      expect(dup).toBe("23505");
    });
  });
});
