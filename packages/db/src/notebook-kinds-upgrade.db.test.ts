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
 * KOBE-464's migration (0169) as an upgrade runs it: existing runs and commands stay, a run may be
 * a `notebook` run, the kernel's three commands are accepted, and anything else is still refused.
 */
const MARKER = "'notebook.execute'";

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const userId = randomUUID();
const threadId = randomUUID();
const runId = randomUUID();

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

const insertRun = (c: pg.Client, id: string, kind: string) =>
  c.query(
    `INSERT INTO runs (id, team_id, thread_id, trigger, kind, status, started_at)
     VALUES ($1, $2, $3, 'user', $4, 'running', now())`,
    [id, teamId, threadId, kind],
  );

const insertCommand = (c: pg.Client, kind: string) =>
  c.query(
    `INSERT INTO sandbox_commands (team_id, user_id, thread_id, kind, frame, requester_replica, expires_at)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, 'r1', now() + interval '1 minute')`,
    [teamId, userId, threadId, kind],
  );

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
      teamId,
      `t${teamId.slice(0, 8)}`,
    ]);
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      userId,
      `${userId}@upgrade.test`,
    ]);
    await c.query(
      `INSERT INTO threads (id, team_id, owner_user_id, title) VALUES ($1, $2, $3, 'T')`,
      [threadId, teamId, userId],
    );
    await c.query(
      `INSERT INTO runs (id, team_id, thread_id, trigger, kind, status, started_at, ended_at)
       VALUES ($1, $2, $3, 'user', 'compaction', 'completed', now(), now())`,
      [runId, teamId, threadId],
    );
    await insertCommand(c, "eval.read");
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("notebook run and command kinds on upgrade (KOBE-464)", () => {
  it("keeps existing rows and takes notebook runs and kernel commands only", async () => {
    const { ownerUrl, appRole, adminUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await withClient(adminUrl, async (c) => {
      const kept = await c.query(`SELECT kind FROM runs WHERE id = $1`, [runId]);
      expect(kept.rows).toEqual([{ kind: "compaction" }]);
      const commands = await c.query(`SELECT kind FROM sandbox_commands WHERE team_id = $1`, [
        teamId,
      ]);
      expect(commands.rows).toEqual([{ kind: "eval.read" }]);
      await insertRun(c, randomUUID(), "notebook");
      await expect(insertRun(c, randomUUID(), "kernel")).rejects.toThrow(/runs_kind/);
      for (const kind of ["notebook.execute", "notebook.interrupt", "notebook.restart"]) {
        await insertCommand(c, kind);
      }
      await expect(insertCommand(c, "notebook.shell")).rejects.toThrow(/sandbox_commands_kind/);
    });
  }, 120_000);
});
