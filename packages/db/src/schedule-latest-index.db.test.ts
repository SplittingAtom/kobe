import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-252: the scheduler's skip dedupe (services/server src/scheduler/fire.ts, latestEvent) reads
 * a schedule's latest schedule.fire / schedule.skip event through events_schedule_latest_idx, as
 * the app role under the team's RLS policy, instead of scanning the team's events.
 */
const INDEX = "events_schedule_latest_idx";
const EVENTS_PER_TEAM = 4000;

// The statement latestEvent builds (drizzle), with its parameters as $1..$2.
const LATEST = `SELECT kind, ref->>'reason' AS reason
  FROM events
 WHERE team_id = $1 AND kind IN ('schedule.fire', 'schedule.skip')
   AND schedule_id = $2
 ORDER BY created_at DESC, due_at DESC NULLS LAST
 LIMIT 1`;

const admin = new pg.Client({ connectionString: inject("adminUrl") });
let app: KobeDatabase;
let team = "";
let schedule = "";

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

/** Every scan node of `events` in a plan. */
function eventScans(node: PlanNode): PlanNode[] {
  const own = node["Relation Name"] === "events" ? [node] : [];
  return [...own, ...(node.Plans ?? []).flatMap(eventScans)];
}

/**
 * A team with many events: run queue rows, and fires and skips for 40 schedules (one of them
 * `scheduleId`). Schedule 1 has fires only at g % 40 = 0 and skips at g % 160 = 1.
 */
async function seedTeam(): Promise<{ teamId: string; scheduleId: string }> {
  const teamId = randomUUID();
  const scheduleIds = Array.from({ length: 40 }, () => randomUUID());
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    teamId,
    `latest-${teamId.slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO events (team_id, kind, status, ref, schedule_id, due_at, created_at)
     SELECT $1, e.kind, 'processed',
            CASE WHEN e.sid IS NULL THEN '{}'::jsonb
                 ELSE jsonb_build_object('schedule_id', e.sid, 'reason', 'missed') END,
            e.sid, now() - make_interval(mins => e.g), now() - make_interval(mins => $3::int - e.g)
       FROM (SELECT g,
                    CASE WHEN g % 4 = 0 THEN 'schedule.fire' WHEN g % 4 = 1 THEN 'schedule.skip'
                         ELSE 'run.queued' END AS kind,
                    CASE WHEN g % 4 = 0 THEN ($2::uuid[])[1 + g % 40]
                         WHEN g % 160 = 1 THEN ($2::uuid[])[1]
                         WHEN g % 4 = 1 THEN ($2::uuid[])[2 + g % 39]
                    END AS sid
               FROM generate_series(1, $3::int) AS g) AS e`,
    [teamId, scheduleIds, EVENTS_PER_TEAM],
  );
  return { teamId, scheduleId: scheduleIds[0] as string };
}

beforeAll(async () => {
  await admin.connect();
  ({ teamId: team, scheduleId: schedule } = await seedTeam());
  await seedTeam(); // another team's rows, so the team key matters
  await admin.query(`ANALYZE events`);
  app = createDb(inject("appUrl"));
});

afterAll(async () => {
  await app.close();
  await admin.end();
});

describe("events_schedule_latest_idx (KOBE-252)", () => {
  it("is a partial index over (team_id, schedule_id, created_at DESC) for fires and skips", async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'events' AND indexname = $1`,
      [INDEX],
    );
    expect(rows[0]?.indexdef).toBe(
      `CREATE INDEX ${INDEX} ON public.events USING btree ` +
        `(team_id, schedule_id, created_at DESC) ` +
        `WHERE (kind = ANY (ARRAY['schedule.fire'::text, 'schedule.skip'::text]))`,
    );
  });

  it("serves the latest-event lookup as the app role, with values and as a generic plan", async () => {
    const plans = await withTeam(app.db, team, async (tx) => {
      const literal = (await tx.execute<{ "QUERY PLAN": PlanNode[] }>(
        sql.raw(
          `EXPLAIN (FORMAT JSON) ${LATEST.replace("$1", `'${team}'`).replace("$2", `'${schedule}'`)}`,
        ),
      )) as unknown as { rows: { "QUERY PLAN": PlanNode[] }[] };
      // A prepared statement (as drizzle's parameters can end up) plans without the values.
      await tx.execute(sql`SET LOCAL plan_cache_mode = force_generic_plan`);
      await tx.execute(sql.raw(`PREPARE kobe_252_latest(uuid, uuid) AS ${LATEST}`));
      try {
        const generic = (await tx.execute(
          sql.raw(`EXPLAIN (FORMAT JSON) EXECUTE kobe_252_latest('${team}', '${schedule}')`),
        )) as unknown as { rows: { "QUERY PLAN": PlanNode[] }[] };
        return [literal, generic].map((r) => r.rows[0]?.["QUERY PLAN"][0] as unknown as PlanNode);
      } finally {
        await tx.execute(sql`DEALLOCATE kobe_252_latest`);
      }
    });
    for (const plan of plans) {
      const scans = eventScans((plan as unknown as { Plan: PlanNode }).Plan);
      expect(scans.map((s) => s["Index Name"])).toEqual([INDEX]);
    }
  });

  it("finds the schedule's latest fire or skip", async () => {
    const latest = async (sid: string) => {
      const res = (await withTeam(app.db, team, (tx) =>
        tx.execute(sql.raw(LATEST.replace("$1", `'${team}'`).replace("$2", `'${sid}'`))),
      )) as unknown as { rows: { kind: string; reason: string | null }[] };
      return res.rows;
    };
    // Schedule 1's newest event is g = 4000 (a fire); its skips stop at g = 3841.
    expect(await latest(schedule)).toEqual([{ kind: "schedule.fire", reason: "missed" }]);
    expect(await latest(randomUUID())).toEqual([]);
  });
});
