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
 * KOBE-451 review HIGH-1's migration (0167) as an upgrade runs it over an existing run: the run
 * keeps a null `mcp_connector_ids` (the server then refuses only its thread's off connectors),
 * and the app role records a new run's connectors in its own team only.
 */
const MARKER = 'ADD COLUMN "mcp_connector_ids"';

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const otherTeam = randomUUID();
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

async function asTeam<T>(team: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return withClient(database().appUrl, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [team]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await withClient(db.adminUrl, async (c) => {
    for (const id of [teamId, otherTeam]) {
      await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
        id,
        `t${id.slice(0, 8)}`,
      ]);
    }
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      userId,
      `${userId}@upgrade.test`,
    ]);
    await c.query(
      `INSERT INTO threads (id, team_id, owner_user_id, title) VALUES ($1, $2, $3, 'T')`,
      [threadId, teamId, userId],
    );
    await c.query(
      `INSERT INTO runs (id, team_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, $3, 'user', 'running', now())`,
      [runId, teamId, threadId],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("runs.mcp_connector_ids on upgrade (KOBE-451)", () => {
  it("leaves an existing run null and records a run's connectors in its own team", async () => {
    const { ownerUrl, appRole } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    const read = (c: pg.Client) =>
      c.query<{ ids: string[] | null }>(`SELECT mcp_connector_ids AS ids FROM runs WHERE id = $1`, [
        runId,
      ]);
    await asTeam(teamId, async (c) => {
      expect((await read(c)).rows).toEqual([{ ids: null }]);
      const connector = randomUUID();
      await c.query(`UPDATE runs SET mcp_connector_ids = $2::uuid[] WHERE id = $1`, [
        runId,
        [connector],
      ]);
      expect((await read(c)).rows).toEqual([{ ids: [connector] }]);
    });
    await asTeam(otherTeam, async (c) => {
      const res = await c.query(`UPDATE runs SET mcp_connector_ids = '{}' WHERE id = $1`, [runId]);
      expect(res.rowCount).toBe(0);
    });
  }, 120_000);
});
