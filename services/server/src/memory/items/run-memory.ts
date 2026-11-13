import { sql, type KobeTx } from "@kobe/db";
import {
  SEMANTIC_MEMORY_POLICY_MAX_ITEMS,
  runSemanticMemorySchema,
  semanticMemoryRunRank,
  type RunSemanticMemory,
  type RunSemanticMemoryItem,
  type SemanticMemoryActorKind,
  type SemanticMemoryKind,
  type SemanticMemoryScope,
  type ThreadContextMemoryItem,
} from "@kobe/protocol";
import { parseRunMemoryState, runMemoryStateQuery, type RunMemoryStateRow } from "../switches.js";
import { memberText, messageText } from "../../threads/messages.js";
import { locate } from "./location.js";
import { trigramSimilarity, trigrams } from "./trigram.js";
import {
  PREFERENCE_BASE,
  RECENCY_DAYS,
  RECENCY_WEIGHT,
  RENDER_LANES,
  STICKY_BONUS,
  selectRunMemory,
  type Candidate,
  type SelectLane,
} from "./select.js";

type SQL = ReturnType<typeof sql>;

/**
 * `run.start.memory.semantic` from the store (KOBE-382; SM23, SM24): reads the candidates of each
 * lane the switches allow for this Workspace, picks with {@link selectRunMemory} and records the
 * item versions given in `run_memory_items` / `run_portable_memory_items` /
 * `run_site_memory_items`, all in the caller's `withTeam()` transaction. Always the **runner's**
 * memory: Workspace rows under RLS, portable rows of the runner only, Site rows only while the
 * Workspace's Site memories are on (Policy follows the Site master switch alone).
 *
 * The caller decides whether a run gets a block at all (agent capability, the agent version's
 * memory setting, evals and test chats: `agents/run-memory.ts`).
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

export interface RunSemanticInput {
  readonly teamId: string;
  /** The runner (the sandbox's user): whose personal and portable items are read. */
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
  /** This run's user message. */
  readonly message: string;
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
}

/**
 * In one round trip: the switches and Site settings, the thread's title, agent and project names,
 * its last two user messages (this run's own is not stored yet) and the items the thread's
 * previous message run was given (stickiness).
 */
async function readQueryContext(tx: KobeTx, input: RunSemanticInput) {
  const { teamId, threadId, runId } = input;
  const res = await tx.execute<ContextRow>(sql`
    SELECT * FROM (${runMemoryStateQuery(teamId)}) AS state, (
    WITH prev AS (
      SELECT r.id FROM runs r
       WHERE r.team_id = ${teamId} AND r.thread_id = ${threadId} AND r.id <> ${runId}
         AND r.kind = 'message'
         AND r.created_at <= (SELECT c.created_at FROM runs c
                               WHERE c.team_id = ${teamId} AND c.id = ${runId})
       ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
    SELECT t.title,
           CASE WHEN t.agent_id IS NULL THEN NULL
                WHEN t.agent_scope = 'team' THEN (
                  SELECT a.frontmatter ->> 'name' FROM team_agents a
                   WHERE a.team_id = t.team_id AND a.id = t.agent_id)
                ELSE (SELECT a.frontmatter ->> 'name' FROM site_agents a WHERE a.id = t.agent_id)
           END AS agent_name,
           (SELECT p.name FROM projects p
             WHERE p.team_id = t.team_id AND p.id = t.project_id) AS project_name,
           (SELECT jsonb_agg(e.content) FROM (
              SELECT payload -> 'message' -> 'content' AS content FROM thread_entries
               WHERE team_id = ${teamId} AND thread_id = ${threadId} AND type = 'message'
                 AND payload -> 'message' ->> 'role' = 'user'
               ORDER BY seq DESC LIMIT ${QUERY_EARLIER_MESSAGES}) e) AS earlier,
           (SELECT jsonb_agg(DISTINCT g.item_id) FROM (
              SELECT item_id FROM run_memory_items
               WHERE team_id = ${teamId} AND run_id = (SELECT id FROM prev)
              UNION ALL SELECT item_id FROM run_portable_memory_items
               WHERE team_id = ${teamId} AND run_id = (SELECT id FROM prev)
              UNION ALL SELECT item_id FROM run_site_memory_items
               WHERE team_id = ${teamId} AND run_id = (SELECT id FROM prev)) g) AS sticky
      FROM threads t
     WHERE t.team_id = ${teamId} AND t.id = ${threadId}) AS ctx`);
  const row = res.rows[0];
  if (!row) throw new Error("the run's thread was not found");
  const messages = (row.earlier ?? []).map((c) => memberText(messageText(c)));
  const text = [input.message, row.title, ...messages, row.agent_name, row.project_name]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join("\n");
  return { ...parseRunMemoryState(row), text, sticky: row.sticky ?? [] };
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
    : sql`NOT ${loc.policy} AND (i.pinned OR i.id = ANY(p.sticky)
          OR COALESCE(v.statement_tsv @@ p.q, false)
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
 * Picks this run's semantic memory and records it. Undefined when no lane applies (the Site
 * master is off): the run then gets no `semantic` field. Throws on anything unexpected; the caller
 * sends the run without a block (fail closed) and the transaction's records roll back.
 */
export async function buildRunSemantic(
  tx: KobeTx,
  input: RunSemanticInput,
): Promise<RunSemanticMemory | undefined> {
  const context = await readQueryContext(tx, input);
  const { memory, settings } = context;
  const lanes = (["user", "portable", "team", "site"] as const).filter((s) => memory.scopes[s]);
  if (!memory.policy && lanes.length === 0) return undefined;
  const q: Query = {
    words: queryWords(context.text),
    message: trigrams(input.message.slice(0, TRIGRAM_MESSAGE_MAX_CHARS)),
    sticky: context.sticky,
  };
  const parts = [...(memory.policy ? (["policy"] as const) : []), ...lanes].map(
    (lane) => sql`SELECT * FROM (${laneQuery(input, lane)}) AS ${sql.raw(`l_${lane}`)}`,
  );
  // Every lane in one statement (one round trip, one plan); the query terms are bound once.
  const tsq =
    q.words.length > 0 ? sql`to_tsquery('english', ${q.words.join(" | ")})` : sql`NULL::tsquery`;
  const { rows } = await tx.execute<ItemRow>(sql`
    WITH p AS (SELECT ${tsq} AS q, ${uuidArray(q.sticky)} AS sticky, now() AS now)
    ${sql.join(parts, sql` UNION ALL `)}`);
  const policy = rows.filter((r) => r.lane === "policy");
  const candidates: Partial<Record<SelectLane, Candidate[]>> = {};
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
  const semantic = runSemanticMemorySchema.parse(
    selectRunMemory({
      policy: policy.map((r) => toItem("site", true, r)),
      lanes: candidates,
      beyond,
      budgetBytes: settings.context_budget_kib * 1024,
    }),
  );
  await recordRunMemory(tx, input.teamId, input.runId, semantic.items);
  return semantic;
}

const RUN_TABLES: Record<SemanticMemoryScope, SQL> = {
  user: sql.raw("run_memory_items"),
  team: sql.raw("run_memory_items"),
  portable: sql.raw("run_portable_memory_items"),
  site: sql.raw("run_site_memory_items"),
};

/**
 * One row per item version given to the run. A start delivered again (a reconnect) adds what it
 * gave on top; rows are never deleted here (run records may be under a legal hold).
 */
export async function recordRunMemory(
  tx: KobeTx,
  teamId: string,
  runId: string,
  items: readonly RunSemanticMemoryItem[],
): Promise<void> {
  const inserts = [...new Set(Object.values(RUN_TABLES))].flatMap((table) => {
    const rows = items.filter((i) => RUN_TABLES[i.scope] === table);
    return rows.length === 0
      ? []
      : [
          sql`INSERT INTO ${table} (team_id, run_id, item_id, version)
              VALUES ${sql.join(
                rows.map(
                  (i) => sql`(${teamId}::uuid, ${runId}::uuid, ${i.id}::uuid, ${i.version})`,
                ),
                sql`, `,
              )}
              ON CONFLICT DO NOTHING`,
        ];
  });
  const last = inserts.pop();
  if (last === undefined) return;
  // One statement: the other tables' inserts ride along as data-modifying CTEs.
  const ctes = inserts.map((ins, i) => sql`${sql.raw(`w${i}`)} AS (${ins})`);
  await tx.execute(ctes.length === 0 ? last : sql`WITH ${sql.join(ctes, sql`, `)} ${last}`);
}

interface RecordRow extends Record<string, unknown> {
  readonly id: string;
  readonly version: number;
  readonly lane: ThreadContextMemoryItem["lane"];
  readonly kind: SemanticMemoryKind;
  readonly statement: string;
  readonly pinned: boolean;
}

/**
 * What the thread's latest message run was given (KOBE-382, U48), for its owner `userId`: the
 * context viewer's memory lanes and Session info's count. Personal and portable rows are read
 * only when they are `userId`'s own (the runner is the thread's owner; this is the wall, not a
 * convenience). `run_id` null: no run yet.
 */
export async function readThreadMemories(
  tx: KobeTx,
  teamId: string,
  userId: string,
  threadId: string,
): Promise<{ runId: string | null; items: ThreadContextMemoryItem[] }> {
  const run = await tx.execute<{ id: string }>(sql`
    SELECT id FROM runs
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND kind = 'message'
     ORDER BY created_at DESC, id DESC LIMIT 1`);
  const runId = run.rows[0]?.id ?? null;
  if (runId === null) return { runId, items: [] };
  const { rows } = await tx.execute<RecordRow>(sql`
    SELECT i.id, r.version, i.scope AS lane, i.kind, v.statement, i.pinned
      FROM run_memory_items r
      JOIN semantic_memory_items i ON i.team_id = r.team_id AND i.id = r.item_id
      JOIN semantic_memory_item_versions v
        ON v.team_id = r.team_id AND v.item_id = r.item_id AND v.version = r.version
     WHERE r.team_id = ${teamId} AND r.run_id = ${runId}
       AND (i.scope = 'team' OR i.owner_user_id = ${userId})
    UNION ALL
    SELECT i.id, r.version, 'portable', i.kind, v.statement, i.pinned
      FROM run_portable_memory_items r
      JOIN portable_memory_items i ON i.id = r.item_id
      JOIN portable_memory_item_versions v ON v.item_id = r.item_id AND v.version = r.version
     WHERE r.team_id = ${teamId} AND r.run_id = ${runId} AND i.owner_user_id = ${userId}
    UNION ALL
    SELECT i.id, r.version, CASE WHEN i.policy THEN 'policy' ELSE 'site' END, i.kind,
           v.statement, i.pinned AND NOT i.policy
      FROM run_site_memory_items r
      JOIN site_memory_items i ON i.id = r.item_id
      JOIN site_memory_item_versions v ON v.item_id = r.item_id AND v.version = r.version
     WHERE r.team_id = ${teamId} AND r.run_id = ${runId}`);
  const laneIndex = (lane: ThreadContextMemoryItem["lane"]) =>
    lane === "policy" ? -1 : RENDER_LANES.indexOf(lane);
  const rankOf = (r: RecordRow) =>
    semanticMemoryRunRank({ policy: r.lane === "policy", pinned: r.pinned });
  const items = [...rows]
    .sort(
      (a, b) =>
        rankOf(a) - rankOf(b) ||
        laneIndex(a.lane) - laneIndex(b.lane) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((r) => ({
      id: r.id,
      version: Number(r.version),
      lane: r.lane,
      kind: r.kind,
      statement: r.statement,
      pinned: r.pinned,
    }));
  return { runId, items };
}
