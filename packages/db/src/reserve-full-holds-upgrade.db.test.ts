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
 * KOBE-443: a site of the release before (through 0151) with live reservations a member took at a
 * larger share migrates as the non-superuser owner. The holds survive and, from the upgrade on,
 * count in full: the call the old function admitted is refused. The app role still calls the
 * function, which stays invoker's rights with its search_path pinned.
 */
const MARKER = "KOBE-443: kobe_reserve_budget counts every live reservation in full";
const LIMIT = 683;
const CALL = 65;

let db: TestDatabase | undefined;
let oldMigrations = "";
const suffix = randomBytes(4).toString("hex");
const team = randomUUID();
const [a, b, c, d] = Array.from({ length: 4 }, () => randomUUID()) as [
  string,
  string,
  string,
  string,
];
const line = [{ scope: "team", unit: "tokens", period: "day", limit: String(LIMIT) }];

async function withClient<T>(url: string, fn: (cl: pg.Client) => Promise<T>): Promise<T> {
  const cl = new pg.Client({ connectionString: url });
  await cl.connect();
  try {
    return await fn(cl);
  } finally {
    await cl.end();
  }
}

const reserve = (cl: pg.Client, who: string, call: string) =>
  cl
    .query<{ r: string }>(
      `SELECT kobe_reserve_budget($1::uuid, $2::uuid, $3, 0::numeric, $4::bigint, 600000,
              0.25::numeric, $5::jsonb, 'salt') AS r`,
      [team, who, call, CALL, JSON.stringify(line)],
    )
    .then((r) => r.rows[0]?.r);

/** One ledger row of `tokens` for `who` today (the run_usage trigger counts it). */
async function spend(cl: pg.Client, who: string, tokens: number): Promise<void> {
  await cl.query("BEGIN");
  await cl.query(`SELECT set_config('kobe.team_id', $1, true)`, [team]);
  await cl.query(
    `INSERT INTO run_usage (team_id, user_id, sandbox_id, kind, run_id, route, model, status,
                            usage_source, duration_ms, input_tokens)
     VALUES ($1, $2, $3, 'run', $4, 'openai', 'p/m', 200, 'reported', 10, $5)`,
    [team, who, randomUUID(), randomUUID(), tokens],
  );
  await cl.query("COMMIT");
}

beforeAll(async () => {
  oldMigrations = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: oldMigrations });
  await withClient(db.adminUrl, async (cl) => {
    for (const id of [a, b, c, d]) {
      await cl.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
        id,
        `u-${id}@fh.test`,
      ]);
    }
    await cl.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Fh')`, [
      team,
      `fh-${suffix}`,
    ]);
    // At spend 0 (share 170.75) a, b and c hold two calls each (390 live).
    for (const who of [a, a, b, b, c, c]) expect(await reserve(cl, who, randomUUID())).toBe("ok");
    // Then 325 of other calls land: share (683 - 325) x 0.25 = 89.5. True exposure 715.
    await spend(cl, d, 325);
    // The release before counts each member at most 89.5 (593.5 < 683) and admits d's call.
    const old = `old-${suffix}`;
    expect(await reserve(cl, d, old)).toBe("ok");
    await cl.query(`DELETE FROM budget_reservations WHERE call_id = $1`, [old]);
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
});

describe("reserve full holds upgrade (KOBE-443)", () => {
  it("keeps the live holds and counts them in full from the upgrade on", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (cl) => {
      const held = await cl.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM budget_reservations WHERE team_id = $1 AND expires_at > now()`,
        [team],
      );
      expect(held.rows[0]?.n).toBe(6);
    });
    await withClient(db.appUrl, async (cl) => {
      expect(await reserve(cl, d, randomUUID())).toBe("full:0");
    });
  });

  it("stays invoker's rights with a pinned search_path", async () => {
    if (!db) throw new Error("database not created");
    await withClient(db.adminUrl, async (cl) => {
      const fn = await cl.query<{ definer: boolean; config: string[] | null; owner: string }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config, pg_get_userbyid(p.proowner) AS owner
           FROM pg_proc p WHERE p.oid = 'public.kobe_reserve_budget'::regproc`,
      );
      expect(fn.rows[0]?.definer).toBe(false);
      expect(fn.rows[0]?.config).toEqual(["search_path=pg_catalog, public"]);
      expect(fn.rows[0]?.owner).not.toBe(db?.appRole);
    });
  });
});
