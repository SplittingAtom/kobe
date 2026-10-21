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
 * KOBE-470's migration as an upgrade runs it: queued commands stay, the sandbox may be asked for
 * a thread's context (`thread.context`), and any other kind is still refused.
 */
const MARKER = "'thread.context'";

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const userId = randomUUID();
const threadId = randomUUID();

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
    await insertCommand(c, "pi.command");
    await expect(insertCommand(c, "thread.context")).rejects.toThrow(/sandbox_commands_kind/);
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("thread.context command kind on upgrade (KOBE-470)", () => {
  it("keeps queued commands and takes thread.context, nothing else new", async () => {
    const { ownerUrl, appRole, adminUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await withClient(adminUrl, async (c) => {
      const kept = await c.query(`SELECT kind FROM sandbox_commands WHERE team_id = $1`, [teamId]);
      expect(kept.rows).toEqual([{ kind: "pi.command" }]);
      await insertCommand(c, "thread.context");
      await expect(insertCommand(c, "thread.contexts")).rejects.toThrow(/sandbox_commands_kind/);
    });
  }, 120_000);
});
