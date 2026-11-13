import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { runSemanticMemorySchema, semanticMemoryRenderedBytes } from "@kobe/protocol";
import { buildRunSemantic } from "./memory/items/run-memory.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-382 ac-4: the selector at the scope limits (SM21 defaults: 1,000 Workspace items with three
 * versions each, 300 of the runner's own, 50 portable, 1,000 Site items, 25 Policy items at the
 * 2 KiB cap) answers within 50 ms at the 95th percentile, recording included. Numbers go in
 * docs/ledger/KOBE-382.md.
 */
let h: Harness;
const team = randomUUID();
let runner = "";
let threadId = "";
let runId = "";

const WORDS = [
  "deploy",
  "release",
  "customer",
  "invoice",
  "budget",
  "roadmap",
  "incident",
  "oncall",
  "database",
  "migration",
  "frontend",
  "backend",
  "design",
  "review",
  "meeting",
  "friday",
  "security",
  "audit",
  "report",
  "quarterly",
  "pricing",
  "contract",
  "vendor",
  "support",
  "latency",
  "cache",
  "kubernetes",
  "helm",
  "postgres",
  "python",
  "typescript",
  "testing",
];
const VOCAB = `ARRAY[${WORDS.map((w) => `'${w}'`).join(",")}]`;
/** A statement of six vocabulary words and a number, ~70-200 bytes. */
const statement = (g: string) =>
  `'Item ' || ${g} || ': ' || (SELECT string_agg((${VOCAB})[1 + ((${g} * k * 7919) % ${WORDS.length})], ' ') FROM generate_series(1, 6 + ${g} % 20) k)`;

beforeAll(async () => {
  h = await openHarness();
  runner = await h.createUser("perf@select.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'perf', 'Perf')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, runner],
  );
  const q = (text: string, params: unknown[] = []) => h.admin.query(text, params);
  await q("BEGIN");
  // Workspace: 1,000 shared items (3 versions each, 10 pinned) and 300 of the runner's own.
  await q(
    `INSERT INTO semantic_memory_items (team_id, id, scope, owner_user_id, kind, pinned, current_version)
     SELECT $1, gen_random_uuid(), CASE WHEN g <= 1000 THEN 'team' ELSE 'user' END,
            CASE WHEN g <= 1000 THEN NULL ELSE $2::uuid END,
            (ARRAY['fact','convention','decision','preference'])[1 + g % 4], g % 100 = 0, 3
       FROM generate_series(1, 1300) g`,
    [team, runner],
  );
  await q(
    `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_user_id, actor_kind, created_at)
     SELECT i.team_id, i.id, v, ${statement("x.g")}, $2, 'user', now() - (x.g % 400) * interval '1 day'
       FROM (SELECT id, team_id, row_number() OVER (ORDER BY id) AS g FROM semantic_memory_items WHERE team_id = $1) x
       JOIN semantic_memory_items i ON i.team_id = x.team_id AND i.id = x.id
       CROSS JOIN generate_series(1, 3) v`,
    [team, runner],
  );
  // Portable: 50 preferences of the runner.
  await q(
    `WITH i AS (INSERT INTO portable_memory_items (id, owner_user_id, kind)
                SELECT gen_random_uuid(), $1, 'preference' FROM generate_series(1, 50) RETURNING id)
     INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
     SELECT id, 1, ${statement("x.g")}, $1, 'user'
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS g FROM i) x`,
    [runner],
  );
  // Site: 1,000 items and 25 Policy items of 80 bytes (2,000 bytes, under the 2 KiB cap).
  await q(
    `WITH i AS (INSERT INTO site_memory_items (id, kind, policy, pinned)
                SELECT gen_random_uuid(), 'fact', g > 1000, g % 100 = 0 AND g <= 1000
                  FROM generate_series(1, 1025) g RETURNING id, policy)
     INSERT INTO site_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
     SELECT id, 1, CASE WHEN policy THEN rpad('Policy ' || x.g, 80, '.') ELSE ${statement("x.g")} END, $1, 'user'
       FROM (SELECT id, policy, row_number() OVER (ORDER BY id) AS g FROM i) x`,
    [runner],
  );
  const thread = await q(
    `INSERT INTO threads (team_id, owner_user_id, status, title) VALUES ($1, $2, 'running', 'Release planning')
     RETURNING id`,
    [team, runner],
  );
  threadId = (thread.rows[0] as { id: string }).id;
  const runs = await q(
    `INSERT INTO runs (team_id, thread_id, trigger, status, created_at, started_at, ended_at)
     VALUES ($1, $2, 'user', 'completed', now() - interval '1 minute', now() - interval '1 minute', now()),
            ($1, $2, 'user', 'running', now(), now(), NULL)
     RETURNING id, status`,
    [team, threadId],
  );
  await q("COMMIT");
  await q("ANALYZE");
  const rows = runs.rows as { id: string; status: string }[];
  const previous = rows.find((r) => r.status === "completed")?.id ?? "";
  runId = rows.find((r) => r.status === "running")?.id ?? "";
  // The previous run's records make some items sticky.
  await build(previous, "deploy release friday");
});

afterAll(async () => {
  await h?.close();
});

const build = (run: string, message: string) =>
  withTeam(h.deps.database.db, team, (tx) =>
    buildRunSemantic(tx, { teamId: team, userId: runner, threadId, runId: run, message }),
  );

const message = (i: number) => MESSAGES[i % MESSAGES.length] ?? "hello";
const MESSAGES = [
  "What did we decide about the database migration and the release on friday?",
  "Draft the quarterly security audit report for the customer",
  "hello",
  "Which vendor contract covers kubernetes and helm support pricing?",
  "Summarise the incident review: latency, cache and the oncall rota",
];

/**
 * The target is 50 ms (ac-4), measured with this file run alone (`KOBE_PERF_STRICT=1`; numbers in
 * the ledger). Under `pnpm verify` many suites share the CPUs and the database, so the default
 * bound only catches a regression of several times.
 */
const P95_MAX_MS = process.env.KOBE_PERF_STRICT === "1" ? 50 : 200;

describe("selector performance at scope limits (ac-4)", () => {
  it(`answers within ${P95_MAX_MS} ms at p95, recording included`, async () => {
    for (let i = 0; i < 10; i++) await build(runId, message(i));
    const times: number[] = [];
    let last;
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      last = await build(runId, message(i));
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
    const semantic = runSemanticMemorySchema.parse(last);
    console.log(
      `KOBE-382 selector: p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, max ${p(1).toFixed(1)} ms; ` +
        `last block ${semantic.items.length} items, ${semanticMemoryRenderedBytes(semantic)} B, omitted ${semantic.omitted_count}`,
    );
    expect(semantic.items.filter((i) => i.policy)).toHaveLength(25);
    expect(semanticMemoryRenderedBytes(semantic)).toBeLessThanOrEqual(8 * 1024);
    expect(p(0.95)).toBeLessThanOrEqual(P95_MAX_MS);
  });
});
