import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-229: the remember replay lookup (services/server src/memory/agent.ts, replayOf) finds the
 * version a tool call already wrote by (team_id, run_id, tool_call_id) through
 * memory_doc_versions_tool_call_idx, as the app role under the team's RLS policy.
 */
const INDEX = "memory_doc_versions_tool_call_idx";
const VERSIONS_PER_TEAM = 2000;

// The statement replayOf builds (drizzle), with its parameters as $1..$3.
const REPLAY = `SELECT d.scope, d.path, v.version
  FROM memory_doc_versions v
  JOIN memory_docs d ON d.team_id = v.team_id AND d.id = v.doc_id
 WHERE v.team_id = $1 AND v.run_id = $2 AND v.tool_call_id = $3`;

const admin = new pg.Client({ connectionString: inject("adminUrl") });
let app: KobeDatabase;
let team = "";
let run = "";

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

/** Every scan node of `memory_doc_versions` in a plan. */
function versionScans(node: PlanNode): PlanNode[] {
  const own = node["Relation Name"] === "memory_doc_versions" ? [node] : [];
  return [...own, ...(node.Plans ?? []).flatMap(versionScans)];
}

async function seedTeam(): Promise<{ teamId: string; runId: string }> {
  const teamId = randomUUID();
  const runId = randomUUID();
  const userId = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
    userId,
    `${userId}@replay.test`,
  ]);
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    teamId,
    `replay-${teamId.slice(0, 8)}`,
  ]);
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO memory_docs (team_id, scope, owner_user_id, path)
     VALUES ($1, 'user', $2, 'MEMORY.md') RETURNING id`,
    [teamId, userId],
  );
  // Even versions: agent writes, one tool call each, over 20 runs (one of them `runId`).
  // Odd versions: people's writes (no run, no tool call).
  await admin.query(
    `INSERT INTO memory_doc_versions
       (team_id, doc_id, version, blob_ref, size_bytes, sha256, actor_kind, actor_user_id, run_id, tool_call_id)
     SELECT $1, $2, g, 'k' || g, 10, repeat('a', 64),
            CASE WHEN g % 2 = 0 THEN 'agent' ELSE 'user' END, $3,
            CASE WHEN g % 2 = 1 THEN NULL WHEN g % 40 = 0 THEN $4::uuid ELSE gen_random_uuid() END,
            CASE WHEN g % 2 = 0 THEN 'call-' || g END
       FROM generate_series(1, $5::int) AS g`,
    [teamId, rows[0]?.id, userId, runId, VERSIONS_PER_TEAM],
  );
  return { teamId, runId };
}

beforeAll(async () => {
  await admin.connect();
  ({ teamId: team, runId: run } = await seedTeam());
  await seedTeam(); // another team's rows, so the team key matters
  await admin.query(`ANALYZE memory_doc_versions`);
  await admin.query(`ANALYZE memory_docs`);
  app = createDb(inject("appUrl"));
});

afterAll(async () => {
  await app.close();
  await admin.end();
});

describe("memory_doc_versions_tool_call_idx (KOBE-229)", () => {
  it("is a partial, non-unique index over (team_id, run_id, tool_call_id)", async () => {
    const { rows } = await admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'memory_doc_versions' AND indexname = $1`,
      [INDEX],
    );
    expect(rows[0]?.indexdef).toBe(
      `CREATE INDEX ${INDEX} ON public.memory_doc_versions USING btree (team_id, run_id, tool_call_id) ` +
        `WHERE ((run_id IS NOT NULL) AND (tool_call_id IS NOT NULL))`,
    );
  });

  it("serves the replay lookup as the app role, with values and as a generic plan", async () => {
    const plans = await withTeam(app.db, team, async (tx) => {
      const literal = (await tx.execute<{ "QUERY PLAN": PlanNode[] }>(
        sql.raw(
          `EXPLAIN (FORMAT JSON) ${REPLAY.replace("$1", `'${team}'`)
            .replace("$2", `'${run}'`)
            .replace("$3", `'call-40'`)}`,
        ),
      )) as unknown as { rows: { "QUERY PLAN": PlanNode[] }[] };
      // A prepared statement (as drizzle's parameters can end up) plans without the values.
      await tx.execute(sql`SET LOCAL plan_cache_mode = force_generic_plan`);
      await tx.execute(sql.raw(`PREPARE kobe_229_replay(uuid, uuid, text) AS ${REPLAY}`));
      try {
        const generic = (await tx.execute(
          sql.raw(`EXPLAIN (FORMAT JSON) EXECUTE kobe_229_replay('${team}', '${run}', 'call-40')`),
        )) as unknown as { rows: { "QUERY PLAN": PlanNode[] }[] };
        return [literal, generic].map((r) => r.rows[0]?.["QUERY PLAN"][0] as unknown as PlanNode);
      } finally {
        await tx.execute(sql`DEALLOCATE kobe_229_replay`);
      }
    });
    for (const plan of plans) {
      const scans = versionScans((plan as unknown as { Plan: PlanNode }).Plan);
      expect(scans.map((s) => s["Index Name"])).toEqual([INDEX]);
    }
  });

  it("finds exactly the tool call's version", async () => {
    const rows = await withTeam(app.db, team, (tx) =>
      tx.execute<{ version: number }>(
        sql`SELECT v.version FROM memory_doc_versions v
             WHERE v.team_id = ${team} AND v.run_id = ${run} AND v.tool_call_id = ${"call-40"}`,
      ),
    );
    expect((rows as unknown as { rows: { version: number }[] }).rows).toEqual([{ version: 40 }]);
  });
});
