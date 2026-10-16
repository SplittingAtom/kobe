import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-252: the scheduler's owner sweep (services/server src/scheduler/owner-sweep.ts) runs every
 * tick on every replica and reads a team's in-flight scheduled runs through
 * runs_schedule_live_idx, as the app role under the team's RLS policy, instead of the team's runs.
 */
const INDEX = "runs_schedule_live_idx";
const THREADS = 400;
const RUNS_PER_THREAD = 25;

// The runs read inactiveOwners sends (owner-sweep.ts), with the team as $1.
const LIVE = `SELECT DISTINCT thread_id FROM runs
 WHERE team_id = $1 AND trigger = 'schedule'
   AND status IN ('queued', 'running', 'waiting_approval')`;

const admin = new pg.Client({ connectionString: inject("adminUrl") });
let app: KobeDatabase;
let team = "";

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

/** The index behind every scan of `runs` in a plan (a bitmap scan's from its index child). */
function runIndexes(node: PlanNode): (string | undefined)[] {
  const own =
    node["Relation Name"] !== "runs"
      ? []
      : node["Node Type"] === "Bitmap Heap Scan"
        ? (node.Plans ?? []).map((c) => c["Index Name"])
        : [node["Index Name"]];
  return [...own, ...(node.Plans ?? []).flatMap(runIndexes)];
}

/**
 * A team with THREADS threads of mostly ended runs; one live scheduled run on every 20th thread
 * (owned by a member who left, `goneId`), a live user run on every 7th.
 */
async function seedTeam(): Promise<{ teamId: string; goneId: string }> {
  const teamId = randomUUID();
  const [stays, goneId] = [randomUUID(), randomUUID()];
  for (const id of [stays, goneId]) {
    await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      id,
      `${id}@sweep.test`,
    ]);
  }
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    teamId,
    `sweep-${teamId.slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder')`,
    [teamId, stays],
  );
  await admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title)
     SELECT $1, gen_random_uuid(), CASE WHEN g % 20 = 0 THEN $3::uuid ELSE $2::uuid END, 't' || g
       FROM generate_series(1, $4::int) AS g`,
    [teamId, stays, goneId, THREADS],
  );
  await admin.query(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
     SELECT t.team_id, t.id, CASE WHEN g % 2 = 0 THEN 'schedule' ELSE 'user' END::run_trigger,
            'completed', now(), now()
       FROM threads t, generate_series(1, $2::int) AS g
      WHERE t.team_id = $1`,
    [teamId, RUNS_PER_THREAD],
  );
  await admin.query(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
     SELECT team_id, id, CASE WHEN owner_user_id = $2 THEN 'schedule' ELSE 'user' END::run_trigger,
            'running', now()
       FROM (SELECT team_id, id, owner_user_id, row_number() OVER (ORDER BY title) AS n
               FROM threads WHERE team_id = $1) t
      WHERE owner_user_id = $2 OR n % 7 = 0`,
    [teamId, goneId],
  );
  return { teamId, goneId };
}

beforeAll(async () => {
  await admin.connect();
  ({ teamId: team } = await seedTeam());
  await seedTeam(); // another team's rows, so the team key matters
  await admin.query(`ANALYZE runs`);
  await admin.query(`ANALYZE threads`);
  app = createDb(inject("appUrl"));
});

afterAll(async () => {
  await app.close();
  await admin.end();
});

describe("runs_schedule_live_idx (KOBE-252)", () => {
  it("is a partial index over (team_id, thread_id) for live scheduled runs", async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'runs' AND indexname = $1`,
      [INDEX],
    );
    expect(rows[0]?.indexdef).toBe(
      `CREATE INDEX ${INDEX} ON public.runs USING btree (team_id, thread_id) ` +
        `WHERE ((trigger = 'schedule'::run_trigger) AND (status = ANY ` +
        `(ARRAY['queued'::run_status, 'running'::run_status, 'waiting_approval'::run_status])))`,
    );
  });

  it("serves the owner sweep as the app role, with values and as a generic plan", async () => {
    const plans = await withTeam(app.db, team, async (tx) => {
      const literal = (await tx.execute(
        sql.raw(`EXPLAIN (FORMAT JSON) ${LIVE.replaceAll("$1", `'${team}'`)}`),
      )) as unknown as { rows: { "QUERY PLAN": PlanNode[] }[] };
      // A prepared statement (as drizzle's parameters can end up) plans without the values.
      await tx.execute(sql`SET LOCAL plan_cache_mode = force_generic_plan`);
      await tx.execute(sql.raw(`PREPARE kobe_252_live(uuid) AS ${LIVE}`));
      try {
        const generic = (await tx.execute(
          sql.raw(`EXPLAIN (FORMAT JSON) EXECUTE kobe_252_live('${team}')`),
        )) as unknown as { rows: { "QUERY PLAN": PlanNode[] }[] };
        return [literal, generic].map((r) => r.rows[0]?.["QUERY PLAN"][0] as unknown as PlanNode);
      } finally {
        await tx.execute(sql`DEALLOCATE kobe_252_live`);
      }
    });
    for (const plan of plans) {
      expect(runIndexes((plan as unknown as { Plan: PlanNode }).Plan)).toEqual([INDEX]);
    }
  });

  it("finds exactly the team's live scheduled runs", async () => {
    const res = (await withTeam(app.db, team, (tx) =>
      tx.execute(sql.raw(LIVE.replaceAll("$1", `'${team}'`))),
    )) as unknown as { rows: { thread_id: string }[] };
    const { rows } = await admin.query<{ id: string }>(
      `SELECT t.id FROM threads t JOIN users u ON u.id = t.owner_user_id
        WHERE t.team_id = $1 AND u.email LIKE '%@sweep.test' AND NOT EXISTS
          (SELECT 1 FROM team_members m WHERE m.team_id = t.team_id AND m.user_id = u.id)`,
      [team],
    );
    expect(res.rows.map((r) => r.thread_id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(rows).toHaveLength(THREADS / 20);
  });
});
