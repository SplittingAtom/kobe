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
 * KOBE-420's backfill of `runs.agent_version` as an upgrade runs it: as the owner role (no
 * superuser, no BYPASSRLS), with FORCE ROW LEVEL SECURITY on runs and run_events and no team set.
 * Runs that started keep the version their `run.started` event recorded; runs without one (no
 * agent, compacted, not started) stay NULL; FORCE is back afterwards.
 */
const MARKER = "KOBE-420: runs.agent_version for runs that started before it existed";

let db: TestDatabase | undefined;
let older = "";
const ids = {
  team: randomUUID(),
  other: randomUUID(),
  user: randomUUID(),
  thread: randomUUID(),
  otherThread: randomUUID(),
};
const runs = {
  v2: randomUUID(),
  v3: randomUUID(),
  noAgent: randomUUID(),
  compacted: randomUUID(),
  queued: randomUUID(),
  otherTeam: randomUUID(),
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
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
      ids.team,
      `a-${ids.team.slice(0, 8)}`,
      ids.other,
      `b-${ids.other.slice(0, 8)}`,
    ]);
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      ids.user,
      `${ids.user}@upgrade.test`,
    ]);
    await c.query(
      `INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $4), ($3, $5, $4)`,
      [ids.team, ids.thread, ids.other, ids.user, ids.otherThread],
    );
    const run = (team: string, thread: string, id: string, started: boolean, compacted = false) =>
      c.query(
        `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at, ended_at, events_compacted_at)
         VALUES ($1, $2, $3, 'user', $4::run_status,
                 CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN now() END,
                 CASE WHEN $6 THEN now() END)`,
        [team, id, thread, started ? "completed" : "queued", started, compacted],
      );
    const startedEvent = (team: string, id: string, version: number | null) =>
      c.query(
        `INSERT INTO run_events (team_id, run_id, type, payload)
         VALUES ($1, $2, 'run.started', jsonb_build_object('agent_version', $3::int))`,
        [team, id, version],
      );
    await run(ids.team, ids.thread, runs.v2, true);
    await startedEvent(ids.team, runs.v2, 2);
    await run(ids.team, ids.thread, runs.v3, true);
    await c.query(
      `INSERT INTO run_events (team_id, run_id, type, payload) VALUES ($1, $2, 'run.queued', '{}')`,
      [ids.team, runs.v3],
    );
    await startedEvent(ids.team, runs.v3, 3);
    await run(ids.team, ids.thread, runs.noAgent, true);
    await startedEvent(ids.team, runs.noAgent, null);
    await run(ids.team, ids.thread, runs.compacted, true, true);
    await run(ids.team, ids.thread, runs.queued, false);
    await run(ids.other, ids.otherThread, runs.otherTeam, true);
    await startedEvent(ids.other, runs.otherTeam, 7);
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("runs.agent_version on upgrade (KOBE-420)", () => {
  it("backfills started runs from run.started as the non-superuser owner and keeps FORCE RLS", async () => {
    const { ownerUrl, appRole, adminUrl } = database();
    await runMigrations({ databaseUrl: ownerUrl, appRole });
    await withClient(adminUrl, async (c) => {
      const res = await c.query<{ id: string; agent_version: number | null }>(
        `SELECT id, agent_version FROM runs`,
      );
      expect(Object.fromEntries(res.rows.map((r) => [r.id, r.agent_version]))).toEqual({
        [runs.v2]: 2,
        [runs.v3]: 3,
        [runs.noAgent]: null,
        [runs.compacted]: null,
        [runs.queued]: null,
        [runs.otherTeam]: 7,
      });
      const rls = await c.query<{ relname: string; enabled: boolean; forced: boolean }>(
        `SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
           FROM pg_class WHERE oid IN ('public.runs'::regclass, 'public.run_events'::regclass)
          ORDER BY relname`,
      );
      expect(rls.rows).toEqual([
        { relname: "run_events", enabled: true, forced: true },
        { relname: "runs", enabled: true, forced: true },
      ]);
    });
  }, 120_000);
});
