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
 * KOBE-326: a site with usage rows and team skill settings migrates through 0143 (eval.read,
 * eval_judge_alias) and 0147 (run_usage kinds eval / eval_judge, NOT VALID) as the non-superuser
 * owner. Existing rows are untouched, every team's judge choice starts unset, the previous
 * release's inserts still pass, and the new kinds hold their shapes.
 */
const MARKER = 'ADD COLUMN "eval_judge_alias"';

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = { user: randomUUID(), team: randomUUID(), sandbox: randomUUID(), run: randomUUID() };

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A ledger row as the previous release's gateway writes it (kind, sandbox, run). */
const usage = (c: pg.Client, kind: string, sandbox: string | null, run: string | null) =>
  c.query(
    `INSERT INTO run_usage (team_id, user_id, sandbox_id, kind, run_id, route, model, status,
                            usage_source, duration_ms)
     VALUES ($1, $2, $3, $4, $5, 'openai', 'p/m', 200, 'reported', 10)`,
    [ids.team, ids.user, sandbox, kind, run],
  );

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
      `bench-${suffix}`,
    ]);
    await c.query(
      `INSERT INTO team_skill_settings (team_id, personal_skills_disabled, updated_by)
       VALUES ($1, true, $2)`,
      [ids.team, ids.user],
    );
    await usage(c, "run", ids.sandbox, ids.run);
    await usage(c, "title", null, ids.run);
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("eval judge upgrade (KOBE-326)", () => {
  it("keeps every row, starts the judge choice unset and widens the kinds NOT VALID", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const settings = await c.query(
        `SELECT personal_skills_disabled, eval_judge_alias FROM team_skill_settings WHERE team_id = $1`,
        [ids.team],
      );
      expect(settings.rows).toEqual([{ personal_skills_disabled: true, eval_judge_alias: null }]);
      const rows = await c.query(`SELECT kind FROM run_usage WHERE team_id = $1 ORDER BY kind`, [
        ids.team,
      ]);
      expect(rows.rows.map((r: { kind: string }) => r.kind)).toEqual(["run", "title"]);
      const checks = await c.query<{ conname: string; convalidated: boolean; def: string }>(
        `SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'run_usage'::regclass AND conname LIKE 'run_usage_kind%' ORDER BY conname`,
      );
      expect(checks.rows.map((r) => [r.conname, r.convalidated])).toEqual([
        ["run_usage_kind", false],
        ["run_usage_kind_shape", false],
      ]);
      expect(checks.rows[0]?.def).toContain("eval_judge");
      const commands = await c.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'sandbox_commands'::regclass AND conname = 'sandbox_commands_kind'`,
      );
      expect(commands.rows[0]?.def).toContain("eval.read");
      const rls = await c.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('run_usage', 'team_skill_settings') ORDER BY relname`,
      );
      expect(rls.rows).toEqual([
        { relrowsecurity: true, relforcerowsecurity: true },
        { relrowsecurity: true, relforcerowsecurity: true },
      ]);
    });
  });

  it("still takes the previous release's rows, and the new kinds only in their shapes", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      await usage(c, "run", randomUUID(), null);
      await usage(c, "followups", null, ids.run);
      await usage(c, "eval_judge", null, ids.run);
      await usage(c, "eval", ids.sandbox, ids.run);
      const refused = (kind: string, sandbox: string | null, run: string | null) =>
        usage(c, kind, sandbox, run).then(
          () => null,
          (e: { constraint?: string }) => e.constraint,
        );
      expect(await refused("eval_judge", ids.sandbox, ids.run)).toBe("run_usage_kind_shape");
      expect(await refused("eval_judge", null, null)).toBe("run_usage_kind_shape");
      expect(await refused("eval", null, ids.run)).toBe("run_usage_kind_shape");
      expect(await refused("judge", null, ids.run)).toBe("run_usage_kind");
      await expect(
        c.query(`UPDATE team_skill_settings SET eval_judge_alias = '' WHERE team_id = $1`, [
          ids.team,
        ]),
      ).rejects.toMatchObject({ constraint: "team_skill_settings_eval_judge_alias" });
    });
  });
});
