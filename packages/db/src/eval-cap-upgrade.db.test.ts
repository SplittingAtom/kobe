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
 * KOBE-327: a site with spend, a live reservation and team skill settings migrates through 0143
 * (eval spend columns, `budget_reservations.eval`, the eval cap) and 0148 (the trigger and
 * `kobe_reserve_budget`) as the non-superuser owner. Existing counters keep their numbers with no
 * eval spend, the reservation stays an ordinary one, no team has a cap, the previous release's
 * reserve call (no eval line) is judged as before, and new eval rows count as eval spend.
 */
const MARKER = 'ADD COLUMN "eval_cost_usd"';

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const ids = { user: randomUUID(), team: randomUUID(), call: `call-${suffix}` };

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const usage = (c: pg.Client, kind: string, tokens: number) =>
  c.query(
    `INSERT INTO run_usage (team_id, user_id, sandbox_id, kind, run_id, route, model, status,
                            usage_source, duration_ms, input_tokens)
     VALUES ($1, $2, $3, $4, $5, 'openai', 'p/m', 200, 'reported', 10, $6)`,
    [ids.team, ids.user, kind === "eval_judge" ? null : randomUUID(), kind, randomUUID(), tokens],
  );

const reserve = (c: pg.Client, call: string, lines: unknown[]) =>
  c
    .query<{ r: string }>(
      `SELECT kobe_reserve_budget($1::uuid, $2::uuid, $3, 0::numeric, 10::bigint, 60000, 1::numeric,
              $4::jsonb, 'salt') AS r`,
      [ids.team, ids.user, call, JSON.stringify(lines)],
    )
    .then((r) => r.rows[0]?.r);

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
      `INSERT INTO team_skill_settings (team_id, personal_skills_disabled, updated_by) VALUES ($1, true, $2)`,
      [ids.team, ids.user],
    );
    await c.query("BEGIN");
    await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [ids.team]);
    await usage(c, "run", 700);
    await c.query("COMMIT");
    // A live reservation of the previous release.
    expect(
      await reserve(c, ids.call, [
        { scope: "team", unit: "tokens", period: "month", limit: "100000" },
      ]),
    ).toBe("ok");
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("eval cap upgrade (KOBE-327)", () => {
  it("keeps the counters and the reservation, with no eval spend and no cap", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      const spend = await c.query(
        `SELECT tokens::int, calls, eval_cost_usd::float AS eval_usd, eval_tokens::int FROM model_spend_daily WHERE team_id = $1`,
        [ids.team],
      );
      expect(spend.rows).toEqual([{ tokens: 700, calls: 1, eval_usd: 0, eval_tokens: 0 }]);
      const held = await c.query(`SELECT eval FROM budget_reservations WHERE call_id = $1`, [
        ids.call,
      ]);
      expect(held.rows).toEqual([{ eval: false }]);
      const settings = await c.query(
        `SELECT personal_skills_disabled, eval_cap_usd, eval_cap_tokens FROM team_skill_settings WHERE team_id = $1`,
        [ids.team],
      );
      expect(settings.rows).toEqual([
        { personal_skills_disabled: true, eval_cap_usd: null, eval_cap_tokens: null },
      ]);
      const rls = await c.query(
        `SELECT relname, relforcerowsecurity FROM pg_class
          WHERE relname IN ('model_spend_daily', 'budget_reservations', 'team_skill_settings') ORDER BY relname`,
      );
      expect(rls.rows.every((r: { relforcerowsecurity: boolean }) => r.relforcerowsecurity)).toBe(
        true,
      );
    });
  });

  it("counts new eval rows as eval spend and judges both kinds of reserve call", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (c) => {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [ids.team]);
      await usage(c, "eval", 300);
      await usage(c, "eval_judge", 50);
      await c.query("COMMIT");
      const spend = await c.query(
        `SELECT sum(tokens)::int AS tokens, sum(eval_tokens)::int AS eval FROM model_spend_daily WHERE team_id = $1`,
        [ids.team],
      );
      expect(spend.rows).toEqual([{ tokens: 1050, eval: 350 }]);
      // The previous release's call shape (no eval line) still passes; an eval line is judged.
      expect(
        await reserve(c, `old-${suffix}`, [
          { scope: "team", unit: "tokens", period: "month", limit: "100000" },
        ]),
      ).toBe("ok");
      expect(
        await reserve(c, `eval-${suffix}`, [
          { scope: "eval", unit: "tokens", period: "month", limit: "350" },
        ]),
      ).toBe("full:0");
      await expect(
        c.query(
          `UPDATE team_skill_settings SET eval_cap_usd = 5, eval_cap_tokens = 5 WHERE team_id = $1`,
          [ids.team],
        ),
      ).rejects.toMatchObject({ constraint: "team_skill_settings_eval_cap" });
    });
  });
});
