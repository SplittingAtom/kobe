import { sql, type SQL } from "drizzle-orm";
import type { KobeTx } from "./client.js";
import type { ThreadStatus } from "./schema/threads.js";
import { TEAM_ID_SETTING } from "./settings.js";
import {
  HIGHLIGHT_START,
  HIGHLIGHT_STOP,
  decodeCursor,
  encodeCursor,
  parseSnippet,
  searchThreadsInputSchema,
  splitQuery,
  type ParsedSearchThreadsInput,
  type SearchThreadsInput,
  type SnippetSegment,
} from "./thread-search-format.js";
import { ThreadSearchError } from "./thread-search-error.js";

export { ThreadSearchError, type ThreadSearchErrorCode } from "./thread-search-error.js";
export {
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_DEFAULT_TIMEOUT_MS,
  THREAD_SEARCH_MAX_LIMIT,
  THREAD_SEARCH_MAX_PROJECT_IDS,
  THREAD_SEARCH_MAX_QUERY_LENGTH,
  type SearchThreadsInput,
  type SnippetSegment,
} from "./thread-search-format.js";

/** Text search configuration; must match the generated `tsv` columns (migration `*_thread_search.sql`). */
const TS_CONFIG = "english";
/** Minimum pg_trgm word_similarity for a title to match the query's positive terms (partial words, typos). */
const TITLE_TRIGRAM_THRESHOLD = 0.6;
/** Weight of the title trigram similarity in the score (full-text title hits weigh more, via 'A'). */
const TITLE_TRIGRAM_WEIGHT = 0.5;
/** ts_rank normalization 1: divide by 1 + log(document length), so long messages don't dominate. */
const RANK_NORMALIZATION = 1;
/**
 * Characters of the matched entry's text given to ts_headline, which parses its whole input: a
 * match beyond this prefix yields an unhighlighted excerpt of the start.
 */
const HEADLINE_INPUT_CHARS = 20_000;
/** SQLSTATEs reported as a timeout: query_canceled (statement_timeout), lock_not_available. */
const TIMEOUT_SQLSTATES = new Set(["57014", "55P03"]);
const HEADLINE_OPTIONS =
  `StartSel=${HIGHLIGHT_START}, StopSel=${HIGHLIGHT_STOP}, ` +
  `MaxWords=30, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "`;

export interface ThreadSearchHit {
  readonly threadId: string;
  readonly title: string | null;
  readonly ownerUserId: string;
  readonly projectId: string | null;
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  readonly status: ThreadStatus;
  readonly sharedToProject: boolean;
  /** The thread's chosen model alias (KOBE-44); null = the team's default. */
  readonly modelAlias: string | null;
  readonly lastActivityAt: Date;
  readonly createdAt: Date;
  /** The active branch's leaf entry. */
  readonly leafEntryId: string | null;
  /** Relevance; hits are ordered by score, then most recent activity. */
  readonly score: number;
  /** Best-matching entry (may be on an inactive branch); null for a title-only match. */
  readonly matchedEntryId: string | null;
  /** Excerpt of the matched entry around the matches; null for a title-only match. */
  readonly snippet: readonly SnippetSegment[] | null;
}

export interface ThreadSearchPage {
  readonly hits: readonly ThreadSearchHit[];
  /** Pass as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

interface HitRow extends Record<string, unknown> {
  id: string;
  title: string | null;
  owner_user_id: string;
  project_id: string | null;
  agent_id: string | null;
  agent_version: number | null;
  status: ThreadStatus;
  shared_to_project: boolean;
  model_alias: string | null;
  activity_micros: string;
  created_micros: string;
  leaf_entry_id: string | null;
  score: number;
  matched_entry_id: string | null;
  headline: string | null;
}

/**
 * Searches the active team's threads that `viewerUserId` may read (spec D9, D23, D24, §6.1): their
 * own threads and threads shared to `projectIds`, never Trash, never another team (RLS, so call it
 * inside `withTeam`). Matches user/assistant message text and titles by full text, and titles by
 * trigram similarity. Read-only; never wakes a sandbox.
 *
 * The caller vouches for the inputs that RLS cannot check: `viewerUserId` must be the signed-in user
 * (KOBE-34) and `projectIds` the projects that user belongs to (KOBE-57); the data layer only adds
 * the team-membership check. Runs in a savepoint with its own statement timeout, so a failure
 * leaves the caller's transaction usable. Throws only `ThreadSearchError` (no SQL or parameters).
 */
export async function searchThreads(
  tx: KobeTx,
  input: SearchThreadsInput,
): Promise<ThreadSearchPage> {
  const parsed = searchThreadsInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "invalid";
    throw new ThreadSearchError("invalid_input", `invalid input: ${message}`);
  }
  const params = parsed.data;
  const cursor = params.cursor === undefined ? undefined : decodeCursor(params.cursor);
  if (cursor === null) throw new ThreadSearchError("invalid_cursor", "invalid cursor");

  const rows = await runBounded(tx, params.timeoutMs, async (sp) => {
    const teamId = await activeTeam(sp);
    return (await sp.execute<HitRow>(searchQuery(teamId, params, cursor))).rows;
  });
  const page = rows.slice(0, params.limit);
  const last = page.at(-1);
  return {
    hits: page.map(toHit),
    nextCursor:
      rows.length > params.limit && last
        ? encodeCursor({ score: last.score, activityMicros: last.activity_micros, id: last.id })
        : null,
  };
}

/**
 * Runs `fn` in a savepoint with `statement_timeout = timeoutMs`, restoring the caller's timeout
 * afterwards (a released savepoint keeps transaction-local settings; a rolled-back one reverts them).
 * Database errors become ThreadSearchError carrying only the SQLSTATE.
 */
async function runBounded<T>(
  tx: KobeTx,
  timeoutMs: number,
  fn: (sp: KobeTx) => Promise<T>,
): Promise<T> {
  try {
    return await tx.transaction(async (sp) => {
      const before = await sp.execute<{ timeout: string }>(
        sql`SELECT current_setting('statement_timeout') AS timeout,
                   set_config('statement_timeout', ${String(timeoutMs)}, true)`,
      );
      const result = await fn(sp);
      await sp.execute(
        sql`SELECT set_config('statement_timeout', ${before.rows[0]?.timeout ?? "0"}, true)`,
      );
      return result;
    });
  } catch (err) {
    if (err instanceof ThreadSearchError) throw err;
    const sqlState = sqlStateOf(err);
    if (sqlState && TIMEOUT_SQLSTATES.has(sqlState)) {
      throw new ThreadSearchError("timeout", `timed out after ${timeoutMs} ms`, sqlState);
    }
    throw new ThreadSearchError(
      "failed",
      `query failed (SQLSTATE ${sqlState ?? "unknown"})`,
      sqlState,
    );
  }
}

/** SQLSTATE of a driver error (drizzle wraps it in `cause`). */
function sqlStateOf(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** The team set by withTeam; refuses to run without one rather than silently finding nothing. */
async function activeTeam(tx: KobeTx): Promise<string> {
  const result = await tx.execute<{ team: string | null }>(
    sql`SELECT NULLIF(current_setting(${TEAM_ID_SETTING}, true), '') AS team`,
  );
  const team = result.rows[0]?.team;
  if (!team) throw new ThreadSearchError("no_team", "must run inside withTeam");
  return team;
}

const fromMicros = (micros: string): Date => new Date(Number(BigInt(micros) / 1000n));

function toHit(row: HitRow): ThreadSearchHit {
  return {
    threadId: row.id,
    title: row.title,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    status: row.status,
    sharedToProject: row.shared_to_project,
    modelAlias: row.model_alias,
    // Raw execute returns timestamps as text; µs → ms (a Date's precision), as drizzle does.
    lastActivityAt: fromMicros(row.activity_micros),
    createdAt: fromMicros(row.created_micros),
    leafEntryId: row.leaf_entry_id,
    score: row.score,
    matchedEntryId: row.matched_entry_id,
    snippet: row.headline === null ? null : parseSnippet(row.headline),
  };
}

/**
 * Visible threads first (owner / project indexes: uuid equality is leakproof, so usable under RLS),
 * then their message entries (thread_entries_search_idx) filtered by `@@`, best entry per thread,
 * then the page, then snippets for the page only. team_id is repeated explicitly so every scan has a
 * team-leading index condition.
 */
function searchQuery(
  teamId: string,
  p: ParsedSearchThreadsInput,
  cursor: ReturnType<typeof decodeCursor> | undefined,
): SQL {
  const projectFilter = p.projectId ? sql`AND t.project_id = ${p.projectId}` : sql``;
  const activityFilter = p.activeSince ? sql`AND t.last_activity_at >= ${p.activeSince}` : sql``;
  const { positive, excluded } = splitQuery(p.query);
  // Title trigram input: positive words only; a title containing an excluded term never matches.
  const exclusions =
    excluded.length > 0
      ? sql`websearch_to_tsquery(${TS_CONFIG}::regconfig, ${excluded.join(" or ")})`
      : sql`NULL::tsquery`;
  const after = cursor
    ? sql`WHERE (s.score, s.activity_micros, s.id) < (${cursor.score}::float8, ${cursor.activityMicros}::bigint, ${cursor.id}::uuid)`
    : sql``;
  return sql`
    WITH params AS MATERIALIZED (
      SELECT websearch_to_tsquery(${TS_CONFIG}::regconfig, ${p.query}) AS tsq,
             ${positive}::text AS trgm, ${exclusions} AS excl
    ),
    visible AS MATERIALIZED (
      SELECT t.team_id, t.id, t.title, t.tsv, t.owner_user_id, t.project_id, t.agent_id,
             t.agent_version, t.status, t.shared_to_project, t.model_alias, t.last_activity_at,
             t.leaf_entry_id, t.created_at
      FROM threads t
      WHERE t.team_id = ${teamId}
        AND t.deleted_at IS NULL
        AND NOT t.is_test
        AND (t.owner_user_id = ${p.viewerUserId}
             OR (t.shared_to_project AND t.project_id = ANY(${sql.param(p.projectIds)}::uuid[])))
        ${projectFilter}
        ${activityFilter}
        AND EXISTS (SELECT 1 FROM team_members m
                    WHERE m.team_id = ${teamId} AND m.user_id = ${p.viewerUserId})
    ),
    entry_hits AS (
      SELECT DISTINCT ON (e.thread_id) e.thread_id, e.entry_id,
             ts_rank(e.tsv, params.tsq, ${RANK_NORMALIZATION})::float8 AS rank
      FROM visible v
      JOIN thread_entries e ON e.team_id = ${teamId} AND e.thread_id = v.id
      CROSS JOIN params
      WHERE e.tsv IS NOT NULL AND e.tsv @@ params.tsq
      ORDER BY e.thread_id, rank DESC, e.seq DESC
    ),
    scored AS (
      SELECT v.*, h.entry_id AS matched_entry_id,
             (extract(epoch FROM v.last_activity_at) * 1000000)::bigint AS activity_micros,
             coalesce(h.rank, 0)
               + CASE WHEN v.tsv @@ params.tsq
                      THEN ts_rank(v.tsv, params.tsq, ${RANK_NORMALIZATION})::float8 ELSE 0 END
               + CASE WHEN trgm.sim >= ${TITLE_TRIGRAM_THRESHOLD}
                      THEN ${TITLE_TRIGRAM_WEIGHT} * trgm.sim ELSE 0 END AS score
      FROM visible v
      CROSS JOIN params
      CROSS JOIN LATERAL (
        SELECT CASE WHEN params.excl IS NOT NULL AND v.tsv @@ params.excl THEN 0
                    ELSE coalesce(word_similarity(params.trgm, v.title), 0) END::float8 AS sim
      ) trgm
      LEFT JOIN entry_hits h ON h.thread_id = v.id
      WHERE h.thread_id IS NOT NULL OR v.tsv @@ params.tsq OR trgm.sim >= ${TITLE_TRIGRAM_THRESHOLD}
    ),
    page AS (
      SELECT s.* FROM scored s
      ${after}
      ORDER BY s.score DESC, s.activity_micros DESC, s.id DESC
      LIMIT ${p.limit + 1}
    ),
    ranked AS (
      SELECT page.*, row_number() OVER (
               ORDER BY page.score DESC, page.activity_micros DESC, page.id DESC) AS rn
      FROM page
    )
    -- Snippets only for the rows returned (not the look-ahead row), from a bounded prefix.
    SELECT r.id, r.title, r.owner_user_id, r.project_id, r.agent_id,
           r.agent_version, r.status, r.shared_to_project, r.model_alias,
           r.activity_micros::text AS activity_micros, r.leaf_entry_id,
           (extract(epoch FROM r.created_at) * 1000000)::bigint::text AS created_micros,
           r.score, r.matched_entry_id,
           CASE WHEN r.rn <= ${p.limit} AND r.matched_entry_id IS NOT NULL THEN
             (SELECT ts_headline(${TS_CONFIG}::regconfig,
                                 left(translate(kobe_entry_search_text(e.type, e.payload),
                                                ${HIGHLIGHT_START + HIGHLIGHT_STOP}, ''),
                                      ${HEADLINE_INPUT_CHARS}),
                                 params.tsq, ${HEADLINE_OPTIONS})
              FROM thread_entries e
              WHERE e.team_id = ${teamId} AND e.thread_id = r.id
                AND e.entry_id = r.matched_entry_id)
           END AS headline
    FROM ranked r CROSS JOIN params
    ORDER BY r.rn`;
}
