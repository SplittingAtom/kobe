import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, searchThreads, withTeam, type KobeDatabase, type KobeTx } from "@kobe/db";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kobe/db/testing";
import { lastMirroredEntryId, mirrorEntriesInTx, restoreParts } from "./sandbox-wire/entries.js";
import { loadRun } from "./sandbox-wire/run-state.js";
import {
  bindUserEntry,
  entryExists,
  latestInterruptedRow,
  lockThreadRow,
  setThreadStatus,
  touchThread,
} from "./runs/store.js";
import { sweepRuns } from "./runs/sweeper.js";
import {
  findThread,
  listEntries,
  listThreads,
  listTrash,
  setLeaf,
  switchAgentVersion,
  updateThread,
  type Viewer,
} from "./threads/repository.js";

/**
 * KOBE-16 decision: `threads` and `thread_entries` carry a second, PERMISSIVE `break_glass_read`
 * policy, which Postgres ORs with the team policy. A query that relies on RLS alone for the team
 * filter loses the team-leading index (measured in the KOBE-16 ledger). So every query on these
 * tables states `team_id` itself. This suite captures the SQL the real code paths send and checks,
 * as the app role with a few hundred teams of data and the break-glass policy present, that every
 * scan of these tables uses an index (team-leading, except full-text search's GIN index) and none
 * is a sequential scan.
 */
const TEAMS = 300;
const THREADS_PER_TEAM = 20;
const ENTRIES_PER_THREAD = 10;
const WATCHED = /\b(threads|thread_entries)\b/;

let database: TestDatabase;
let app: KobeDatabase;
let admin: pg.Client;
let teamId = "";
let ownerId = "";
let threadId = "";
let runId = "";
let teamLeading = new Set<string>();

interface Captured {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Records every statement the app sends on any pg client while `fn` runs. */
async function capture(fn: () => Promise<void>): Promise<Captured[]> {
  const seen: Captured[] = [];
  const original = pg.Client.prototype.query;
  const patched = function (this: pg.Client, ...args: unknown[]) {
    const [first, second] = args;
    if (typeof first === "string") {
      seen.push({ text: first, values: Array.isArray(second) ? second : [] });
    } else if (first && typeof first === "object" && "text" in first) {
      const config = first as { text: string; values?: unknown[] };
      seen.push({
        text: config.text,
        values: config.values ?? (Array.isArray(second) ? second : []),
      });
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  pg.Client.prototype.query = patched as typeof original;
  try {
    await fn();
  } finally {
    pg.Client.prototype.query = original;
  }
  return seen.filter(
    (s) =>
      WATCHED.test(s.text) && !/^\s*(insert|explain)\b/i.test(s.text) && !/set_config/.test(s.text),
  );
}

/** Runs `fn` in the team's transaction and rolls it back (writes are only planned). */
async function inTeamRolledBack(fn: (tx: KobeTx) => Promise<unknown>): Promise<void> {
  const rollback = new Error("rollback");
  await withTeam(app.db, teamId, async (tx) => {
    await fn(tx);
    throw rollback;
  }).catch((err: unknown) => {
    if (err !== rollback) throw err;
  });
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}

function scans(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) scans(child, out);
  return out;
}

/** EXPLAINs each statement as the app role inside the team context; returns the scan nodes. */
async function plansOf(
  statements: readonly Captured[],
): Promise<{ text: string; nodes: PlanNode[] }[]> {
  const client = await app.pool.connect();
  try {
    const out: { text: string; nodes: PlanNode[] }[] = [];
    for (const s of statements) {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamId]);
        const res = await client.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
          `EXPLAIN (FORMAT JSON) ${s.text}`,
          [...s.values],
        );
        const plan = res.rows[0]?.["QUERY PLAN"][0]?.Plan;
        if (plan) out.push({ text: s.text, nodes: scans(plan) });
      } catch (err) {
        throw new Error(
          `EXPLAIN failed (${String(err)}): ${s.text.replace(/\s+/g, " ").slice(0, 200)}`,
          { cause: err },
        );
      } finally {
        await client.query("ROLLBACK");
      }
    }
    return out;
  } finally {
    client.release();
  }
}

/** Every scan of threads/thread_entries is an index scan; team-leading unless `anyIndex`. */
async function expectIndexed(
  statements: Captured[],
  options: { anyIndex?: boolean } = {},
): Promise<void> {
  expect(statements.length, "captured no statement on threads/thread_entries").toBeGreaterThan(0);
  // The same statement for many teams (e.g. a per-team sweep) is planned once.
  statements = [...new Map(statements.map((st) => [st.text, st])).values()];
  for (const { text, nodes } of await plansOf(statements)) {
    const relational = nodes.filter(
      (n) => n["Relation Name"] === "threads" || n["Relation Name"] === "thread_entries",
    );
    const indexNodes = nodes.filter((n) => n["Index Name"] !== undefined);
    const watchedIndexes = indexNodes
      .map((n) => n["Index Name"] ?? "")
      .filter((name) => /^(threads|thread_entries)_/.test(name));
    const label = text.replace(/\s+/g, " ").slice(0, 160);
    expect(relational.filter((n) => n["Node Type"] === "Seq Scan").map(() => label)).toEqual([]);
    if (!options.anyIndex) {
      expect(
        watchedIndexes.filter((i) => !teamLeading.has(i)),
        label,
      ).toEqual([]);
      // The index must be entered by the team the query names itself (a literal or parameter),
      // or by a join to another table's team_id; not only by the policies' current_setting(...)
      // and break-glass InitPlan arms (RLS-only queries).
      const explicitTeam = /team_id = ('[0-9a-f-]{36}'::uuid|\$\d+|\w+\.team_id)/;
      const unbounded = indexNodes
        .filter((n) => teamLeading.has(n["Index Name"] ?? ""))
        .filter((n) => !explicitTeam.test(n["Index Cond"] ?? ""));
      expect(
        unbounded.map((n) => `${n["Index Name"]}: ${n["Index Cond"] ?? "no condition"}`),
        label,
      ).toEqual([]);
    }
  }
}

beforeAll(async () => {
  database = await createTestDatabase(testServerUrl());
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  // Seeded as the superuser in bulk (seq triggers off; seq set directly).
  await admin.query(`
    INSERT INTO teams (id, slug, name)
      SELECT gen_random_uuid(), 'plan-' || i, 'Plan ' || i FROM generate_series(1, ${TEAMS}) i;
    INSERT INTO users (id, name, email)
      SELECT gen_random_uuid(), 'Owner ' || t.slug, t.slug || '@plans.test' FROM teams t;
    INSERT INTO team_members (team_id, user_id, role)
      SELECT t.id, u.id, 'member' FROM teams t JOIN users u ON u.email = t.slug || '@plans.test';
    INSERT INTO threads (team_id, id, owner_user_id, title, last_activity_at)
      SELECT m.team_id, gen_random_uuid(), m.user_id, 'quarterly report ' || i, now() - i * interval '1 minute'
      FROM team_members m, generate_series(1, ${THREADS_PER_TEAM}) i;
    ALTER TABLE thread_entries DISABLE TRIGGER thread_entries_assign_seq;
    INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, seq, type, payload)
      SELECT th.team_id, th.id, 'e' || i, CASE WHEN i > 1 THEN 'e' || (i - 1) END, i, 'message',
             jsonb_build_object('message', jsonb_build_object('role', 'user', 'content', 'budget numbers ' || i))
      FROM threads th, generate_series(1, ${ENTRIES_PER_THREAD}) i;
    ALTER TABLE thread_entries ENABLE TRIGGER thread_entries_assign_seq;
    ALTER TABLE threads DISABLE TRIGGER threads_guard_last_entry_seq;
    UPDATE threads SET last_entry_seq = ${ENTRIES_PER_THREAD}, leaf_entry_id = 'e${ENTRIES_PER_THREAD}';
    ALTER TABLE threads ENABLE TRIGGER threads_guard_last_entry_seq;
    INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at, ended_at)
      SELECT team_id, gen_random_uuid(), id, 'user', 'completed', now(), now() FROM threads;
    ANALYZE;`);
  const pick = await admin.query<{ team_id: string; owner: string; thread: string; run: string }>(`
    SELECT th.team_id, th.owner_user_id AS owner, th.id AS thread, r.id AS run
    FROM threads th JOIN runs r ON r.team_id = th.team_id AND r.thread_id = th.id
    WHERE th.team_id = (SELECT id FROM teams WHERE slug = 'plan-${TEAMS / 2}') LIMIT 1`);
  const row = pick.rows[0];
  if (!row) throw new Error("seed failed");
  ({ team_id: teamId, owner: ownerId, thread: threadId, run: runId } = row);
  const idx = await admin.query<{ name: string }>(`
    SELECT i.indexrelid::regclass::text AS name
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid IN ('threads'::regclass, 'thread_entries'::regclass) AND a.attname = 'team_id'`);
  teamLeading = new Set(idx.rows.map((r) => r.name));
  app = createDb(database.appUrl, { max: 2 });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await database?.drop();
});

const viewer = (): Viewer => ({ teamId, userId: ownerId, projectIds: [] });

describe("hot thread queries use the team-leading index with the break-glass policy present", () => {
  it("has the break-glass policy it is checking against", async () => {
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM pg_policy WHERE polname = 'break_glass_read'`,
    );
    expect(rows[0]).toEqual({ n: 2 });
  });

  it("thread list, Trash and thread lookup (repository)", async () => {
    const statements = await capture(() =>
      inTeamRolledBack(async (tx) => {
        await listThreads(tx, viewer(), { cursor: null, limit: 20 });
        await listTrash(tx, viewer(), { cursor: null, limit: 20 });
        await findThread(tx, viewer(), threadId);
      }),
    );
    await expectIndexed(statements);
  });

  it("entries page, rename and leaf switch (repository)", async () => {
    const statements = await capture(() =>
      inTeamRolledBack(async (tx) => {
        await listEntries(tx, viewer(), threadId, 0, 50);
        await updateThread(tx, viewer(), threadId, { title: "renamed" });
        await setLeaf(tx, viewer(), threadId, "e5");
      }),
    );
    await expectIndexed(statements);
  });

  it("sandbox wire: last mirrored entry, mirroring, restore pages, run lookup", async () => {
    const statements = await capture(async () => {
      await inTeamRolledBack(async (tx) => {
        await lastMirroredEntryId(tx, teamId, threadId);
        await mirrorEntriesInTx(
          tx,
          teamId,
          threadId,
          {
            entries: [
              { type: "message", id: "e11", parentId: "e10", timestamp: "2026-10-02T00:00:00Z" },
            ],
            leafId: "e11",
          } as Parameters<typeof mirrorEntriesInTx>[3],
          10_000,
        );
        await loadRun(tx, teamId, runId);
      });
      for await (const _part of restoreParts(app.db, teamId, threadId)) {
        // Drains the pages.
      }
    });
    await expectIndexed(statements);
  });

  it("run orchestrator: thread lock, entry check, activity, status, prompt binding, retry lookup (KOBE-30)", async () => {
    const statements = await capture(() =>
      inTeamRolledBack(async (tx) => {
        await lockThreadRow(tx, teamId, threadId);
        await entryExists(tx, teamId, threadId, "e3");
        await touchThread(tx, teamId, threadId);
        await setThreadStatus(tx, teamId, threadId, "idle");
        await bindUserEntry(tx, teamId, runId);
        await latestInterruptedRow(tx, teamId, threadId);
        // KOBE-46: switching the pinned agent version locks the thread first.
        await switchAgentVersion(tx, viewer(), threadId, undefined);
      }),
    );
    await expectIndexed(statements);
  });

  it("run sweep across teams (KOBE-30)", async () => {
    const silent = { error: () => undefined } as unknown as Parameters<typeof sweepRuns>[2];
    const statements = await capture(async () => {
      await sweepRuns(
        app.db,
        { startDeadlineMs: 60_000, stopResendMs: 60_000, stallMs: 60_000 } as Parameters<
          typeof sweepRuns
        >[1],
        silent,
      );
    });
    await expectIndexed(statements);
  });

  it("thread search (full-text: the entries' GIN index is allowed)", async () => {
    const statements = await capture(() =>
      inTeamRolledBack((tx) =>
        searchThreads(tx, { viewerUserId: ownerId, projectIds: [], query: "budget" }),
      ),
    );
    await expectIndexed(statements, { anyIndex: true });
  });

  it("catches a query that leaves the team filter to RLS (guard self-test)", async () => {
    await expect(
      expectIndexed([{ text: "SELECT * FROM threads WHERE id = $1", values: [threadId] }]),
    ).rejects.toThrow(/WHERE id = \$1: expected \[/);
  });

  it("logs the RLS-only cost the explicit filter avoids (by design, not enforced)", async () => {
    /** Rows the thread_entries scans touched (returned + removed by filter), and the time. */
    async function analyze(text: string, values: unknown[]) {
      const client = await app.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamId]);
        const res = await client.query<{
          "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[];
        }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, values);
        await client.query("ROLLBACK");
        const top = res.rows[0]?.["QUERY PLAN"][0];
        const touched = scans(top?.Plan as PlanNode)
          .filter((n) => n["Relation Name"] === "thread_entries")
          .reduce((sum, n) => {
            const m = n as PlanNode & { "Actual Rows"?: number; "Rows Removed by Filter"?: number };
            return sum + (m["Actual Rows"] ?? 0) + (m["Rows Removed by Filter"] ?? 0);
          }, 0);
        return { touched, ms: top?.["Execution Time"] ?? 0 };
      } finally {
        client.release();
      }
    }
    const rlsOnly = await analyze("SELECT count(*) FROM thread_entries", []);
    const explicit = await analyze("SELECT count(*) FROM thread_entries WHERE team_id = $1", [
      teamId,
    ]);
    console.info(
      `thread_entries count(*) with ${TEAMS} teams: RLS only ${rlsOnly.ms.toFixed(2)} ms ` +
        `(${rlsOnly.touched} rows touched), explicit team_id ${explicit.ms.toFixed(2)} ms ` +
        `(${explicit.touched} rows touched)`,
    );
    // The explicit filter touches only the team's rows. The RLS-only cost depends on the plan
    // Postgres picks for the OR'd policies (from no extra rows to every tenant's rows); it is
    // logged here and recorded in the KOBE-16 ledger, not asserted.
    expect(explicit.touched).toBe(THREADS_PER_TEAM * ENTRIES_PER_THREAD);
    expect(rlsOnly.ms).toBeGreaterThan(0);
  });
});
