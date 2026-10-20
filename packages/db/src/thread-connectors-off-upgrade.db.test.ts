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
 * KOBE-451's migrations (0165 table, 0166 RLS) as an upgrade runs them (the owner role) over an
 * existing thread and connector: the app role stores an "off" row only in its own team (FORCE
 * RLS), one per (thread, connector), and the row goes with its thread and with its connector.
 */
const MARKER = 'CREATE TABLE "thread_connectors_off"';

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const otherTeam = randomUUID();
const userId = randomUUID();
const threadId = randomUUID();
const connectorId = randomUUID();

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

const turnOff = (c: pg.Client, team = teamId, connector = connectorId) =>
  c.query(
    `INSERT INTO thread_connectors_off (team_id, thread_id, connector_id, turned_off_by)
     VALUES ($1, $2, $3, $4)`,
    [team, threadId, connector, userId],
  );
const count = async (c: pg.Client) =>
  (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM thread_connectors_off`)).rows[0]?.n;

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
      `INSERT INTO connectors (id, name, url) VALUES ($1, 'up-conn', 'https://x.example/mcp')`,
      [connectorId],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("thread_connectors_off on upgrade (KOBE-451)", () => {
  it("stores an existing thread's off connector, once, only in the caller's own team", async () => {
    const { ownerUrl, appRole } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await asTeam(teamId, async (c) => {
      await turnOff(c);
      expect(await count(c)).toBe(1);
    });
    await expect(asTeam(teamId, (c) => turnOff(c))).rejects.toThrow(/duplicate key/);
    expect(await asTeam(otherTeam, count)).toBe(0);
    for (const team of [otherTeam, teamId]) {
      await expect(asTeam(otherTeam, (c) => turnOff(c, team))).rejects.toThrow(
        /row-level security|foreign key/,
      );
    }
  });

  it("goes with its connector and with its thread", async () => {
    const { adminUrl } = database();
    const second = randomUUID();
    await withClient(adminUrl, (c) =>
      c.query(
        `INSERT INTO connectors (id, name, url) VALUES ($1, 'up-conn-2', 'https://y.example/mcp')`,
        [second],
      ),
    );
    await asTeam(teamId, (c) => turnOff(c, teamId, second));
    await withClient(adminUrl, async (c) => {
      await c.query(`DELETE FROM connectors WHERE id = $1`, [second]);
      expect(await count(c)).toBe(1);
      await c.query(`DELETE FROM threads WHERE id = $1`, [threadId]);
      expect(await count(c)).toBe(0);
    });
  });
});
