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
 * every existing thread reads as an ordinary one, every command and lease as the member's own
 * sandbox (slot ''), and RLS stays forced. The previous release's wire SQL (its connect upsert on
 * (team_id, user_id), command and lease inserts without a slot) keeps working on the migrated
 * schema: old pods during a rolling upgrade and after a helm rollback still connect and run.
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
      const key = await c.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'sandbox_connections'::regclass AND contype = 'p'`,
      );
      expect(key.rows).toEqual([{ def: "PRIMARY KEY (team_id, user_id)" }]);
      const cmd = await c.query(`SELECT slot FROM sandbox_commands WHERE user_id = $1`, [ids.user]);
      expect(cmd.rows).toEqual([{ slot: "" }]);
      const rls = await c.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('threads', 'sandbox_connections', 'sandbox_eval_connections',
                            'skill_eval_runs', 'skill_eval_results')
          ORDER BY relname`,
      );
      expect(rls.rows.map((r: { relforcerowsecurity: boolean }) => r.relforcerowsecurity)).toEqual([
        true,
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

  it("runs the previous release's connect, command and lease SQL on the migrated schema", async () => {
    if (!db) throw new Error("database not created");
    const second = randomUUID();
    await withClient(db.adminUrl, (c) =>
      c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U2', $2)`, [
        second,
        `u2-${suffix}@example.test`,
      ]),
    );
    await withClient(db.appUrl, async (c) => {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [ids.team]);
      // ConnectionRegistry.register of the previous release, verbatim: a reconnect...
      const again = await c.query(
        `INSERT INTO sandbox_connections
           (team_id, user_id, sandbox_id, connection_id, replica_id, connected_at, last_seen_at)
         VALUES ($1, $2, $3, $4, 'old', now(), now())
         ON CONFLICT (team_id, user_id) DO NOTHING`,
        [ids.team, ids.user, ids.sandbox, randomUUID()],
      );
      expect(again.rowCount).toBe(0);
      const locked = await c.query(
        `SELECT connection_id, closed_at FROM sandbox_connections
          WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
        [ids.team, ids.user],
      );
      expect(locked.rowCount).toBe(1);
      const updated = await c.query(
        `UPDATE sandbox_connections
            SET sandbox_id = $3, connection_id = $4, replica_id = 'old', connected_at = now(),
                last_seen_at = now(), closed_at = NULL
          WHERE team_id = $1 AND user_id = $2`,
        [ids.team, ids.user, ids.sandbox, randomUUID()],
      );
      expect(updated.rowCount).toBe(1);
      // ...and a first connection.
      const first = await c.query(
        `INSERT INTO sandbox_connections
           (team_id, user_id, sandbox_id, connection_id, replica_id, connected_at, last_seen_at)
         VALUES ($1, $2, $3, $4, 'old', now(), now())
         ON CONFLICT (team_id, user_id) DO NOTHING`,
        [ids.team, second, randomUUID(), randomUUID()],
      );
      expect(first.rowCount).toBe(1);
      // enqueueCommand and the delivery's lease of the previous release (no slot).
      await c.query(
        `INSERT INTO sandbox_commands
           (team_id, id, user_id, thread_id, run_id, kind, frame, requester_replica, expires_at)
         VALUES ($1, $2, $3, $4, NULL, 'run.stop', '{}'::jsonb, 'old', now() + make_interval(secs => 60))`,
        [ids.team, randomUUID(), ids.user, ids.thread],
      );
      const run = await c.query<{ id: string }>(
        `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
         VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
        [ids.team, ids.thread],
      );
      const lease = `INSERT INTO sandbox_run_leases (team_id, run_id, user_id, thread_id, sandbox_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (team_id, run_id) DO UPDATE
           SET sandbox_id = EXCLUDED.sandbox_id, leased_at = now()
           WHERE sandbox_run_leases.user_id = EXCLUDED.user_id
             AND sandbox_run_leases.thread_id = EXCLUDED.thread_id`;
      const params = [ids.team, run.rows[0]?.id, ids.user, ids.thread, ids.sandbox];
      expect((await c.query(lease, params)).rowCount).toBe(1);
      expect((await c.query(lease, params)).rowCount).toBe(1);
      await c.query("COMMIT");
    });
  });
});
