import { z } from "zod";
import { SEMANTIC_MEMORY_KINDS, type SemanticMemoryKind } from "@kobe/protocol";
import {
  eligible,
  memoryScore,
  relevanceScore,
  SELECT_LANES,
  type Candidate,
  type SelectLane,
} from "../../memory/items/select.js";

/**
 * Scoring for the memory eval harness (KOBE-387, `e2e/memory-eval.sh`), without a database:
 * fixture schemas, the rankings recall is measured on, recall@k and its summaries, and the
 * cache-read share of a replayed thread. KOBE-400 extends the same harness for the extractor.
 */

export const RECALL_K = 8;
/** Gate A's line (spec SM25/SM30): vectors (Phase D) only if overall recall@8 is below it. */
export const RECALL_GATE = 0.85;

const fixtureId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const kind = z.enum(SEMANTIC_MEMORY_KINDS);

export const relevanceItemSchema = z.strictObject({
  id: fixtureId,
  scope: z.enum(SELECT_LANES),
  kind,
  statement: z.string().min(1).max(500),
  age_days: z.number().int().min(0).max(3650),
});
export type RelevanceItem = z.infer<typeof relevanceItemSchema>;

export const QUERY_STYLES = ["literal", "paraphrase", "indirect"] as const;
export type QueryStyle = (typeof QUERY_STYLES)[number];

export const relevanceQuerySchema = z.strictObject({
  id: z.string().regex(/^q\d{3}$/),
  kind,
  style: z.enum(QUERY_STYLES),
  query: z.string().min(1).max(2000),
  expected: z.array(fixtureId).min(1).max(5),
  negatives: z.array(fixtureId).max(5).optional(),
});
export type RelevanceQuery = z.infer<typeof relevanceQuerySchema>;

const itemsFileSchema = z.object({ items: z.array(relevanceItemSchema).min(1) });
const queriesFileSchema = z.object({ queries: z.array(relevanceQuerySchema).min(1) });

/**
 * Parses both fixture files and checks they agree: unique ids, every expected and negative id is
 * an item, no id both expected and negative, a query's kind is its first expected item's kind.
 * Throws with every problem listed.
 */
export function parseRelevanceSet(
  itemsJson: unknown,
  queriesJson: unknown,
): { readonly items: RelevanceItem[]; readonly queries: RelevanceQuery[] } {
  const { items } = itemsFileSchema.parse(itemsJson);
  const { queries } = queriesFileSchema.parse(queriesJson);
  const problems: string[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  if (byId.size !== items.length) problems.push("duplicate item ids");
  if (new Set(queries.map((q) => q.id)).size !== queries.length) {
    problems.push("duplicate query ids");
  }
  for (const i of items) {
    if (i.scope === "portable" && i.kind !== "preference") {
      problems.push(`${i.id}: portable items are preferences`);
    }
  }
  for (const q of queries) {
    for (const id of [...q.expected, ...(q.negatives ?? [])]) {
      if (!byId.has(id)) problems.push(`${q.id}: unknown item ${id}`);
    }
    if (q.negatives?.some((n) => q.expected.includes(n))) {
      problems.push(`${q.id}: an item is both expected and a negative`);
    }
    const first = byId.get(q.expected[0] ?? "");
    if (first && first.kind !== q.kind) {
      problems.push(`${q.id}: kind ${q.kind} but ${first.id} is a ${first.kind}`);
    }
  }
  if (problems.length > 0) throw new Error(`relevance set: ${problems.join("; ")}`);
  return { items, queries };
}

/**
 * How candidates are ordered for recall@k:
 * - `relevance` (the Gate A number): the selector's eligible candidates ordered by SM24
 *   relevance, `ts_rank_cd + 0.3 · trigram + 0.1 · recency`;
 * - `selector`: the selector's full score, which adds the 0.5 base of person-lane preferences
 *   (they are always eligible and always rank above relevance, so they fill the top of every
 *   list) and the stickiness bonus.
 */
export type RankMode = "relevance" | "selector";
export const RANK_MODES: readonly RankMode[] = ["relevance", "selector"];

/** Item ids of every eligible candidate of every lane, best first (pinned, score, id). */
export function rankCandidates(
  lanes: Partial<Record<SelectLane, readonly Candidate[]>>,
  mode: RankMode,
): string[] {
  const ranked: { id: string; pinned: boolean; score: number }[] = [];
  for (const lane of SELECT_LANES) {
    for (const c of lanes[lane] ?? []) {
      if (!eligible(c, lane)) continue;
      const score = mode === "relevance" ? relevanceScore(c) : memoryScore(c, lane);
      ranked.push({ id: c.item.id, pinned: c.item.pinned, score });
    }
  }
  ranked.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      b.score - a.score ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return ranked.map((r) => r.id);
}

/** Share of `expected` found in the first `k` of `ranked` (0 for an empty `expected`). */
export function recallAtK(
  ranked: readonly string[],
  expected: readonly string[],
  k: number,
): number {
  if (expected.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  return expected.filter((e) => top.has(e)).length / expected.length;
}

/** 1-based rank of each expected id in `ranked`, null when it is not there. */
export function ranksOf(ranked: readonly string[], ids: readonly string[]): (number | null)[] {
  return ids.map((id) => {
    const at = ranked.indexOf(id);
    return at < 0 ? null : at + 1;
  });
}

/** One query's outcome (fixture ids throughout). */
export interface QueryResult {
  readonly id: string;
  readonly kind: SemanticMemoryKind;
  readonly style: QueryStyle;
  /** recall@k per rank mode. */
  readonly recall: Record<RankMode, number>;
  /** Share of the expected items inside the block the selector picked at the Site's budget. */
  readonly inBlock: number;
  /** A hard negative ranks above every expected item found in the top k (relevance order). */
  readonly negativeAbove: boolean;
  /** Ranks of the expected items in the relevance order (null: not a candidate at all). */
  readonly ranks: (number | null)[];
}

/** Scores one query from its rankings and the block's item ids. */
export function scoreQuery(
  q: RelevanceQuery,
  ranked: Record<RankMode, readonly string[]>,
  block: ReadonlySet<string>,
  k = RECALL_K,
): QueryResult {
  const rel = ranked.relevance;
  const expectedRanks = ranksOf(rel, q.expected);
  const bestExpected = Math.min(
    ...expectedRanks.filter((r): r is number => r !== null && r <= k),
    Number.POSITIVE_INFINITY,
  );
  const negativeAbove = ranksOf(rel, q.negatives ?? []).some(
    (r) => r !== null && r <= k && r < bestExpected,
  );
  return {
    id: q.id,
    kind: q.kind,
    style: q.style,
    recall: {
      relevance: recallAtK(rel, q.expected, k),
      selector: recallAtK(ranked.selector, q.expected, k),
    },
    inBlock: q.expected.filter((e) => block.has(e)).length / q.expected.length,
    negativeAbove,
    ranks: expectedRanks,
  };
}

/** Means of one group of queries. */
export interface RecallRow {
  readonly queries: number;
  readonly relevance: number;
  readonly selector: number;
  readonly inBlock: number;
  /** Share of the group's queries with negatives where a negative ranked above the answer. */
  readonly negativeAbove: number | null;
}

export interface RelevanceReport {
  readonly k: number;
  readonly overall: RecallRow;
  readonly byKind: Record<SemanticMemoryKind, RecallRow>;
  readonly byStyle: Record<QueryStyle, RecallRow>;
  /** Overall relevance recall@k is below RECALL_GATE: Phase D (vectors) is on. */
  readonly vectorsIndicated: boolean;
}

const mean = (xs: readonly number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

function row(results: readonly QueryResult[], withNegatives: ReadonlySet<string>): RecallRow {
  const neg = results.filter((r) => withNegatives.has(r.id));
  return {
    queries: results.length,
    relevance: mean(results.map((r) => r.recall.relevance)),
    selector: mean(results.map((r) => r.recall.selector)),
    inBlock: mean(results.map((r) => r.inBlock)),
    negativeAbove: neg.length === 0 ? null : mean(neg.map((r) => (r.negativeAbove ? 1 : 0))),
  };
}

/** Macro means (every query weighs the same) overall, per kind and per style. */
export function summarise(
  results: readonly QueryResult[],
  queries: readonly RelevanceQuery[],
  k = RECALL_K,
): RelevanceReport {
  const withNegatives = new Set(
    queries.filter((q) => (q.negatives ?? []).length > 0).map((q) => q.id),
  );
  const group = <K extends string>(keys: readonly K[], of: (r: QueryResult) => K) =>
    Object.fromEntries(
      keys.map((key) => [
        key,
        row(
          results.filter((r) => of(r) === key),
          withNegatives,
        ),
      ]),
    ) as Record<K, RecallRow>;
  const overall = row(results, withNegatives);
  return {
    k,
    overall,
    byKind: group(SEMANTIC_MEMORY_KINDS, (r) => r.kind),
    byStyle: group(QUERY_STYLES, (r) => r.style),
    vectorsIndicated: overall.relevance < RECALL_GATE,
  };
}

const pct = (x: number | null) => (x === null ? "-" : `${(100 * x).toFixed(1)}%`);
const num = (x: number) => x.toFixed(3);

/** The report as a Markdown table, as gate-7a.md records it. */
export function formatRelevanceReport(r: RelevanceReport): string {
  const line = (label: string, x: RecallRow) =>
    `| ${label} | ${x.queries} | ${num(x.relevance)} | ${num(x.selector)} | ${num(x.inBlock)} | ${pct(x.negativeAbove)} |`;
  return [
    `| Group | Queries | recall@${r.k} (relevance) | recall@${r.k} (selector score) | in block | negative above answer |`,
    "| --- | --- | --- | --- | --- | --- |",
    line("**overall**", r.overall),
    ...SEMANTIC_MEMORY_KINDS.map((k) => line(k, r.byKind[k])),
    ...QUERY_STYLES.map((s) => line(`style: ${s}`, r.byStyle[s])),
    "",
    `Gate A: overall recall@${r.k} ${num(r.overall.relevance)} ${
      r.vectorsIndicated ? "<" : ">="
    } ${RECALL_GATE} → Phase D vectors ${r.vectorsIndicated ? "indicated" : "not indicated"}.`,
  ].join("\n");
}

// --- cache-read share (memory-eval.sh cache) --------------------------------------------------

/** One run's gateway usage, as `GET /v1/threads/{id}/usage` returns it per run. */
export const runUsageSchema = z.object({
  run_id: z.string(),
  calls: z.number().int().min(0),
  input_tokens: z.number().min(0),
  cache_read_tokens: z.number().min(0),
  cache_write_tokens: z.number().min(0),
});
export type RunUsage = z.infer<typeof runUsageSchema>;

export interface CacheShare {
  readonly runs: number;
  readonly calls: number;
  readonly cacheRead: number;
  /** Prompt tokens: uncached input + cache reads + cache writes (the gate-7a.md SQL). */
  readonly prompt: number;
  /** cacheRead / prompt, null when there were no prompt tokens. */
  readonly share: number | null;
}

function shareOf(runs: readonly RunUsage[]): CacheShare {
  const sum = (f: (u: RunUsage) => number) => runs.reduce((a, u) => a + f(u), 0);
  const cacheRead = sum((u) => u.cache_read_tokens);
  const prompt = sum((u) => u.input_tokens + u.cache_read_tokens + u.cache_write_tokens);
  return {
    runs: runs.length,
    calls: sum((u) => u.calls),
    cacheRead,
    prompt,
    share: prompt === 0 ? null : cacheRead / prompt,
  };
}

/**
 * The cache-read share of a replayed thread: over all turns and over turns 2..n (turn 1 can never
 * read the cache). `turnRunIds` are the replay's runs in the order sent; usage of other runs of
 * the thread is ignored, and a turn without usage counts as nothing.
 */
export function cacheShares(
  usage: readonly RunUsage[],
  turnRunIds: readonly string[],
): { readonly all: CacheShare; readonly afterFirst: CacheShare; readonly missing: string[] } {
  const byRun = new Map(usage.map((u) => [u.run_id, u]));
  const turns = turnRunIds.map((id) => byRun.get(id));
  const present = (list: (RunUsage | undefined)[]) =>
    list.filter((u): u is RunUsage => u !== undefined);
  return {
    all: shareOf(present(turns)),
    afterFirst: shareOf(present(turns.slice(1))),
    missing: turnRunIds.filter((id) => !byRun.has(id)),
  };
}

export function formatCacheShare(label: string, s: CacheShare): string {
  return `${label}: runs ${s.runs}, calls ${s.calls}, cache read ${s.cacheRead}, prompt ${s.prompt}, share ${pct(s.share)}`;
}
