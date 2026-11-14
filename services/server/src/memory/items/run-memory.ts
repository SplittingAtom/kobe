import { createHash } from "node:crypto";
import { sql, type KobeTx } from "@kobe/db";
import {
  SEMANTIC_MEMORY_POLICY_MAX_ITEMS,
  runSemanticMemorySchema,
  type RunSemanticMemory,
  type RunSemanticMemoryItem,
  type SemanticMemoryActorKind,
  type SemanticMemoryKind,
  type SemanticMemoryScope,
} from "@kobe/protocol";
import { parseRunMemoryState, runMemoryStateQuery, type RunMemoryStateRow } from "../switches.js";
import { memberText, messageText } from "../../threads/messages.js";
import { locate } from "./location.js";
import { readRunRecords, recordToRunItem } from "./run-records.js";
import { trigramSimilarity, trigrams } from "./trigram.js";
import {
  PREFERENCE_BASE,
  RECENCY_DAYS,
  RECENCY_WEIGHT,
  SELECT_LANES,
  STICKY_BONUS,
  selectRunMemory,
  type Candidate,
  type SelectLane,
} from "./select.js";

type SQL = ReturnType<typeof sql>;

/**
 * `run.start.memory.semantic` from the store (KOBE-382; SM23, SM24): reads the candidates of each
 * lane the switches allow for this Workspace and picks with {@link selectRunMemory}, in the
 * caller's `withTeam()` transaction. Always the **runner's** memory: Workspace rows under RLS,
 * portable rows of the runner only, Site rows only while the Workspace's Site memories are on
 * (Policy follows the Site master switch alone). The caller records the selection once the
 * sandbox accepted the start (`run-records.ts`); a start delivered again gets what was recorded.
 *
 * The caller decides whether a run gets a block at all and whether it is Policy only (agent
 * capability, the agent version's memory setting, evals and test chats: `agents/run-memory.ts`).
 */

/**
 * Most candidates read per lane (best first by `ts_rank` and the rest of the score). The block
 * holds at most 100 items in all, ~80 at the largest budget with typical statements; eligible items
 * past this count as omitted.
 */
export const LANE_READ_MAX = 64;
/** The query text (message, title, earlier messages, names) is cut to this many characters. */
export const QUERY_MAX_CHARS = 4000;
/** Words of the query used for full-text matching. */
export const QUERY_MAX_WORDS = 64;
/** The message is cut to this many characters for trigram similarity. */
export const TRIGRAM_MESSAGE_MAX_CHARS = 500;
/** Earlier user messages of the thread in the query (SM24). */
export const QUERY_EARLIER_MESSAGES = 2;
/** Most entries walked up the run's branch looking for them. */
export const QUERY_PATH_MAX_ENTRIES = 500;

export interface RunSemanticInput {
  readonly teamId: string;
  /** The runner (the sandbox's user): whose personal and portable items are read. */
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
  /** This run's user message. */
  readonly message: string;
  /** Site Policy only (an agent version with `notes_only` or `off`, Chris 2026-11-13). */
  readonly policyOnly?: boolean;
}

/** The words of `text` the full-text query ORs together (letters and digits only). */
export function queryWords(text: string): string[] {
  const words = text
    .slice(0, QUERY_MAX_CHARS)
    .toLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu);
  return [...new Set(words ?? [])].slice(0, QUERY_MAX_WORDS);
}

interface ContextRow extends RunMemoryStateRow {
  readonly title: string | null;
  readonly agent_name: string | null;
  readonly project_name: string | null;
  readonly earlier: unknown[] | null;
  readonly sticky: string[] | null;
  readonly recorded: boolean;
}

/**
 * In one round trip: the switches and Site settings; whether this run already has records (a
 * start delivered again); the thread's title, agent and project names; the last two user
 * messages on the run's branch (walking up from the run's `parent_entry_id`, else the thread's
 * leaf, so a sibling branch never counts); and the items the thread's previous message run was
 * given (stickiness).
 */
async function readQueryContext(tx: KobeTx, input: RunSemanticInput) {
  const { teamId, threadId, runId } = input;
  const recorded = (table: string) =>
    sql`EXISTS (SELECT 1 FROM ${sql.raw(table)} WHERE team_id = ${teamId} AND run_id = ${runId})`;
  const res = await tx.execute<ContextRow>(sql`
    SELECT * FROM (${runMemoryStateQuery(teamId)}) AS state, (
    WITH RECURSIVE prev AS (
      SELECT r.id FROM runs r
       WHERE r.team_id = ${teamId} AND r.thread_id = ${threadId} AND r.id <> ${runId}
         AND r.kind = 'message'
         AND r.created_at <= (SELECT c.created_at FROM runs c
                               WHERE c.team_id = ${teamId} AND c.id = ${runId})
       ORDER BY r.created_at DESC, r.id DESC LIMIT 1
    ), path AS (
      SELECT e.entry_id, e.parent_id, 1 AS depth,
             (e.type = 'message' AND e.payload -> 'message' ->> 'role' = 'user')::int AS users
        FROM thread_entries e
       WHERE e.team_id = ${teamId} AND e.thread_id = ${threadId}
         AND e.entry_id = COALESCE(
               (SELECT r.parent_entry_id FROM runs r WHERE r.team_id = ${teamId} AND r.id = ${runId}),
               (SELECT t.leaf_entry_id FROM threads t WHERE t.team_id = ${teamId} AND t.id = ${threadId}))
      UNION ALL
      SELECT e.entry_id, e.parent_id, path.depth + 1,
             path.users + (e.type = 'message' AND e.payload -> 'message' ->> 'role' = 'user')::int
        FROM path JOIN thread_entries e
          ON e.team_id = ${teamId} AND e.thread_id = ${threadId} AND e.entry_id = path.parent_id
       WHERE path.users < ${QUERY_EARLIER_MESSAGES} AND path.depth < ${QUERY_PATH_MAX_ENTRIES}
    )
    SELECT t.title,
           CASE WHEN t.agent_id IS NULL THEN NULL
                WHEN t.agent_scope = 'team' THEN (
                  SELECT a.frontmatter ->> 'name' FROM team_agents a
                   WHERE a.team_id = t.team_id AND a.id = t.agent_id)
                ELSE (SELECT a.frontmatter ->> 'name' FROM site_agents a WHERE a.id = t.agent_id)
           END AS agent_name,
           (SELECT p.name FROM projects p
             WHERE p.team_id = t.team_id AND p.id = t.project_id) AS project_name,
           (SELECT jsonb_agg(e.payload -> 'message' -> 'content' ORDER BY path.depth)
              FROM path JOIN thread_entries e
                ON e.team_id = ${teamId} AND e.thread_id = ${threadId} AND e.entry_id = path.entry_id
             WHERE e.type = 'message' AND e.payload -> 'message' ->> 'role' = 'user') AS earlier,
           (SELECT jsonb_agg(DISTINCT g.item_id) FROM (
              SELECT item_id FROM run_memory_items
               WHERE team_id = ${teamId} AND run_id = (SELECT id FROM prev)
              UNION ALL SELECT item_id FROM run_portable_memory_items
               WHERE team_id = ${teamId} AND run_id = (SELECT id FROM prev)
              UNION ALL SELECT item_id FROM run_site_memory_items
               WHERE team_id = ${teamId} AND run_id = (SELECT id FROM prev)) g) AS sticky,
           (${recorded("run_memory_items")} OR ${recorded("run_portable_memory_items")}
             OR ${recorded("run_site_memory_items")}) AS recorded
      FROM threads t
     WHERE t.team_id = ${teamId} AND t.id = ${threadId}) AS ctx`);
  const row = res.rows[0];
  if (!row) throw new Error("the run's thread was not found");
  // This run's own message, if Pi already stored it (a start delivered again), is not "earlier".
  const messages = (row.earlier ?? [])
    .map((c) => memberText(messageText(c)))
    .filter((m) => m !== input.message);
  const text = [input.message, row.title, ...messages, row.agent_name, row.project_name]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join("\n");
  return { ...parseRunMemoryState(row), text, sticky: row.sticky ?? [], recorded: row.recorded };
}

/** A `uuid[]` as one bound parameter (the values are uuids the database returned). */
const uuidArray = (values: readonly string[]): SQL => sql`${`{${values.join(",")}}`}::uuid[]`;

interface ItemRow extends Record<string, unknown> {
  readonly lane: SelectLane | "policy";
  readonly id: string;
  readonly kind: SemanticMemoryKind;
  readonly pinned: boolean;
  readonly version: number;
  readonly statement: string;
  readonly actor_kind: SemanticMemoryActorKind;
  readonly as_of: string | null;
  readonly saved_on: string;
  readonly matched: boolean;
  readonly rank: number | string;
  readonly age_days: number | string;
  readonly sticky: boolean;
  readonly total: number | string;
}

const toItem = (
  scope: SemanticMemoryScope,
  policy: boolean,
  r: ItemRow,
): RunSemanticMemoryItem => ({
  id: r.id,
  version: Number(r.version),
  scope,
  kind: r.kind,
  statement: r.statement,
  policy,
  pinned: policy ? false : r.pinned,
  provenance: { actor_kind: r.actor_kind, as_of: r.as_of, saved_on: r.saved_on },
});

const raw = (n: number) => sql.raw(String(n));

interface Query {
  readonly words: string[];
  /** Trigrams of this run's message (pg_trgm's similarity, computed here: trigram.ts). */
  readonly message: ReadonlySet<number>;
  readonly sticky: readonly string[];
}

/**
 * The query of the best {@link LANE_READ_MAX} candidates of one lane (or every Policy item),
 * current versions only, with their relevance parts and how many were eligible in all. The ORDER BY mirrors
 * `memoryScore` (select.ts) so the cut keeps the ones the selector would rank first.
 */
function laneQuery(input: RunSemanticInput, lane: SelectLane | "policy"): SQL {
  const scope: SemanticMemoryScope = lane === "policy" ? "site" : lane;
  const loc = locate(scope, input.teamId, input.userId);
  const personal = lane === "user" || lane === "portable";
  const policy = lane === "policy";
  const base = personal
    ? sql`CASE WHEN i.kind = 'preference' THEN ${raw(PREFERENCE_BASE)} ELSE 0 END`
    : sql`0`;
  const filter = policy
    ? sql`${loc.policy}`
    : sql`NOT ${loc.policy} AND (i.pinned OR COALESCE(v.statement_tsv @@ p.q, false)
          ${personal ? sql`OR i.kind = 'preference'` : sql``})`;
  // Policy is taken whole, unranked. A lane is read in two steps to stay within 50 ms at the
  // scope limits (no index helps under FORCE RLS): every eligible row is ranked with the cheap
  // `ts_rank` plus the rest of its score, then the best LANE_READ_MAX get `ts_rank_cd`; the
  // server adds 0.3 · trigram (trigram.ts) and the selector orders them by the full score.
  return sql`
    SELECT ${lane}::text AS lane, c.id, c.kind, c.pinned, c.version, c.statement, c.actor_kind,
           to_char(c.as_of, 'YYYY-MM-DD') AS as_of,
           to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS saved_on,
           c.matched, ${policy ? sql`0::float8` : sql`COALESCE(ts_rank_cd(c.statement_tsv, p.q), 0)`} AS rank,
           c.age_days, c.sticky, c.total
      FROM (
        SELECT x.*, count(*) OVER () AS total
          FROM (
            SELECT i.id, i.kind, i.pinned, i.current_version AS version, v.statement,
                   v.statement_tsv, v.actor_kind, ${loc.asOf} AS as_of, v.created_at,
                   GREATEST(0, extract(epoch FROM p.now - v.created_at)::float8 / 86400) AS age_days,
                   i.id = ANY(p.sticky) AS sticky,
                   COALESCE(v.statement_tsv @@ p.q, false) AS matched,
                   ${policy ? sql`0::float8` : sql`COALESCE(ts_rank(v.statement_tsv, p.q), 0)`} AS quick,
                   ${base} AS base
              FROM ${loc.items} i
              JOIN ${loc.versions} v ON ${loc.versionOf} AND v.version = i.current_version
              CROSS JOIN p
             WHERE ${loc.where} AND i.status = 'active' AND ${filter}
          ) x
         ORDER BY x.pinned DESC,
                  x.quick + x.base + CASE WHEN x.sticky THEN ${raw(STICKY_BONUS)} ELSE 0 END
                    + ${raw(RECENCY_WEIGHT)} * GREATEST(0, 1 - x.age_days / ${raw(RECENCY_DAYS)}) DESC,
                  x.id
         LIMIT ${policy ? SEMANTIC_MEMORY_POLICY_MAX_ITEMS * 4 : LANE_READ_MAX}
      ) c CROSS JOIN p`;
}

/**
 * Executes `query` as a named prepared statement on the transaction's connection, so Postgres
 * plans the lanes UNION once per connection and shape (~5 ms a run at the scope limits) instead
 * of every message. Falls back to a plain execute if the driver's internals ever change.
 */
async function executePrepared(tx: KobeTx, query: SQL): Promise<ItemRow[]> {
  type T = ItemRow;
  const inner = tx as unknown as {
    dialect?: { sqlToQuery(q: SQL): { sql: string; params: unknown[] } };
    session?: {
      client?: {
        query(c: { name: string; text: string; values: unknown[] }): Promise<{ rows: T[] }>;
      };
    };
  };
  const client = inner.session?.client;
  if (!inner.dialect || typeof client?.query !== "function")
    return (await tx.execute<T>(query)).rows as T[];
  const { sql: text, params } = inner.dialect.sqlToQuery(query);
  const name = `kobe_sm_${createHash("sha256").update(text).digest("hex").slice(0, 24)}`;
  return (await client.query({ name, text, values: params })).rows;
}

/**
 * Picks this run's semantic memory (not recorded: the caller records it once the sandbox accepted
 * the start). A run that already has records gets exactly those again (a start delivered twice).
 * Undefined when nothing applies (the Site master is off, or Policy only and there is none).
 * Throws on anything unexpected; the caller then falls back to {@link buildPolicyOnly}.
 */
export async function buildRunSemantic(
  tx: KobeTx,
  input: RunSemanticInput,
): Promise<{ readonly semantic: RunSemanticMemory; readonly fresh: boolean } | undefined> {
  const context = await readQueryContext(tx, input);
  if (context.recorded) {
    const items = (await readRunRecords(tx, input.teamId, input.userId, input.runId)).map(
      recordToRunItem,
    );
    return { semantic: runSemanticMemorySchema.parse({ items, omitted_count: 0 }), fresh: false };
  }
  const { memory, settings } = context;
  const lanes = input.policyOnly
    ? []
    : (["user", "portable", "team", "site"] as const).filter((s) => memory.scopes[s]);
  if (!memory.policy && lanes.length === 0) return undefined;
  const q: Query = {
    words: queryWords(context.text),
    message: trigrams(input.message.slice(0, TRIGRAM_MESSAGE_MAX_CHARS)),
    sticky: context.sticky,
  };
  const rows = await readLanes(tx, input, memory.policy, lanes, q);
  const semantic = select(rows, lanes, q, settings.context_budget_kib * 1024);
  if (semantic.items.length === 0 && input.policyOnly) return undefined;
  return { semantic, fresh: true };
}

/**
 * The relevance harness's view of one run (KOBE-387, `e2e/memory-eval.sh relevance`): the
 * candidates of every enabled lane with their relevance parts, read exactly as
 * {@link buildRunSemantic} reads them, and the selection it would make. Nothing is recorded and
 * run records are ignored, so the same run can be asked about many messages.
 */
export async function readRunCandidates(
  tx: KobeTx,
  input: RunSemanticInput,
): Promise<{ readonly candidates: LaneCandidates; readonly semantic: RunSemanticMemory }> {
  const context = await readQueryContext(tx, input);
  const { memory, settings } = context;
  const lanes = SELECT_LANES.filter((s) => memory.scopes[s]);
  const q: Query = {
    words: queryWords(context.text),
    message: trigrams(input.message.slice(0, TRIGRAM_MESSAGE_MAX_CHARS)),
    sticky: context.sticky,
  };
  const rows = await readLanes(tx, input, memory.policy, lanes, q);
  return {
    candidates: toCandidates(rows, lanes, q).candidates,
    semantic: select(rows, lanes, q, settings.context_budget_kib * 1024),
  };
}

/**
 * The fallback when the full build fails (L5): Site Policy alone, so a broken lane never drops
 * governance. Undefined when the Site master is off or there is no Policy.
 */
export async function buildPolicyOnly(
  tx: KobeTx,
  input: RunSemanticInput,
): Promise<RunSemanticMemory | undefined> {
  const { memory, settings } = parseRunMemoryState(
    (await tx.execute<RunMemoryStateRow>(runMemoryStateQuery(input.teamId))).rows[0],
  );
  if (!memory.policy) return undefined;
  const q: Query = { words: [], message: new Set(), sticky: [] };
  const rows = await readLanes(tx, input, true, [], q);
  const semantic = select(rows, [], q, settings.context_budget_kib * 1024);
  return semantic.items.length === 0 ? undefined : semantic;
}

async function readLanes(
  tx: KobeTx,
  input: RunSemanticInput,
  policy: boolean,
  lanes: readonly SelectLane[],
  q: Query,
): Promise<ItemRow[]> {
  const parts = [...(policy ? (["policy"] as const) : []), ...lanes].map(
    (lane) => sql`SELECT * FROM (${laneQuery(input, lane)}) AS ${sql.raw(`l_${lane}`)}`,
  );
  if (parts.length === 0) return [];
  // Every lane in one prepared statement (one round trip, one plan); query terms bound once.
  return executePrepared(
    tx,
    sql`
    WITH p AS (SELECT to_tsquery('english', NULLIF(${q.words.join(" | ")}, '')) AS q,
                      ${uuidArray(q.sticky)} AS sticky, now() AS now)
    ${sql.join(parts, sql` UNION ALL `)}`,
  );
}

type LaneCandidates = Partial<Record<SelectLane, Candidate[]>>;

/** The candidates of each lane with their relevance parts, and the eligible ones not read. */
function toCandidates(
  rows: readonly ItemRow[],
  lanes: readonly SelectLane[],
  q: Query,
): { readonly candidates: LaneCandidates; readonly beyond: Partial<Record<SelectLane, number>> } {
  const candidates: LaneCandidates = {};
  const beyond: Partial<Record<SelectLane, number>> = {};
  for (const lane of lanes) {
    const mine = rows.filter((r) => r.lane === lane);
    candidates[lane] = mine.map((r) => ({
      item: toItem(lane, false, r),
      matched: r.matched,
      textRank: Number(r.rank),
      trigram: trigramSimilarity(r.statement, q.message),
      ageDays: Number(r.age_days),
      sticky: r.sticky,
    }));
    beyond[lane] = Number(mine[0]?.total ?? 0) - mine.length;
  }
  return { candidates, beyond };
}

function select(
  rows: readonly ItemRow[],
  lanes: readonly SelectLane[],
  q: Query,
  budgetBytes: number,
): RunSemanticMemory {
  const { candidates, beyond } = toCandidates(rows, lanes, q);
  return runSemanticMemorySchema.parse(
    selectRunMemory({
      policy: rows.filter((r) => r.lane === "policy").map((r) => toItem("site", true, r)),
      lanes: candidates,
      beyond,
      budgetBytes,
    }),
  );
}
