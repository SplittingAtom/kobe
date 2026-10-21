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
 * KOBE-462's migration (0168) as an upgrade runs it over an existing run: the run keeps a null
 * `viewing` (no viewed-file note), and the app role records a run's viewed file in its own team
 * only.
 */
const MARKER = 'ADD COLUMN "viewing"';

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

describe("runs.viewing on upgrade (KOBE-462)", () => {
  it("leaves an existing run null and records a run's viewed file in its own team", async () => {
    const { ownerUrl, appRole } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    const read = (c: pg.Client) =>
      c.query<{ viewing: unknown }>(`SELECT viewing FROM runs WHERE id = $1`, [runId]);
    const viewing = { path: "notes.md", sha256: "a".repeat(64), size: 3, truncated: false };
    await asTeam(teamId, async (c) => {
      expect((await read(c)).rows).toEqual([{ viewing: null }]);
      await c.query(`UPDATE runs SET viewing = $2::jsonb WHERE id = $1`, [
        runId,
        JSON.stringify(viewing),
      ]);
      expect((await read(c)).rows).toEqual([{ viewing }]);
    });
    await asTeam(otherTeam, async (c) => {
      const res = await c.query(`UPDATE runs SET viewing = NULL WHERE id = $1`, [runId]);
      expect(res.rowCount).toBe(0);
    });
  }, 120_000);
});
