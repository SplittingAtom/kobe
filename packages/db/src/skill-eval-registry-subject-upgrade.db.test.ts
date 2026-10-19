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
 * KOBE-335 (0153): an install with eval runs upgrades; old runs keep their subjects and a run may
 * now evaluate a Registry version; any other kind is still refused.
 */
const MARKER = `'draft', 'team', 'personal', 'registry'`;

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = { user: randomUUID(), team: randomUUID(), old: randomUUID() };

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const run = (c: pg.Client, id: string, kind: string) =>
  c.query(
    `INSERT INTO skill_eval_runs (team_id, id, started_by, subject_kind, subject_id, subject_rev,
       skill_name, package_hash, runtime_hash, bundle_key, bundle_size, mode, status, suite,
       limits, progress_total)
     VALUES ($1, $2, $3, $4, $5, 1, 'x', repeat('a', 64), repeat('b', 64), 'k', 1, 'full',
       'queued', '{}', '{}', 1)`,
    [ids.team, id, ids.user, kind, randomUUID()],
  );

async function inTeam(c: pg.Client, fn: () => Promise<unknown>) {
  await c.query("BEGIN");
  try {
    await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [ids.team]);
    await fn();
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
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
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
      ids.team,
      `t-${suffix}`,
    ]);
    await inTeam(c, () => run(c, ids.old, "team"));
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("eval runs of Registry versions (KOBE-335)", () => {
  it("keeps old runs and accepts the registry subject only", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const old = await c.query(`SELECT subject_kind FROM skill_eval_runs WHERE id = $1`, [
        ids.old,
      ]);
      expect(old.rows).toEqual([{ subject_kind: "team" }]);
      await inTeam(c, () => run(c, randomUUID(), "registry"));
      await expect(inTeam(c, () => run(c, randomUUID(), "catalog"))).rejects.toThrow(
        /skill_eval_runs_subject_kind/,
      );
    });
  });
});
