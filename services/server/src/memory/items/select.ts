import {
  SEMANTIC_MEMORY_RENDER_BLOCK_OVERHEAD_BYTES,
  SEMANTIC_MEMORY_RENDER_ITEM_OVERHEAD_BYTES,
  SEMANTIC_MEMORY_RENDER_LANE_OVERHEAD_BYTES,
  semanticMemoryRunFence,
  SEMANTIC_MEMORY_RUN_MAX_ITEMS,
  type RunSemanticMemory,
  type RunSemanticMemoryItem,
} from "@kobe/protocol";

/**
 * Semantic memory selection for one run (KOBE-382; spec SM23, SM24, Chris Q6), without the
 * database. Re-picked on every message. Policy first (all of it that fits the budget), then
 * pinned items in render order, then four lanes (person-in-Workspace `user`, `portable`,
 * Workspace `team`, `site`) share what is left of the Site's context budget for the per-message
 * picks: each lane first gets up to a 1 KiB floor, then the rest flows to the best remaining
 * candidates of any lane. Nothing ever goes past the budget.
 * Whole items only: an item that does not fit is skipped, never cut. `omitted_count` counts the
 * eligible items left out.
 *
 * Output order is cache-stable: Policy, then pinned items, then the per-message picks; inside
 * each group by lane (render order) and then item id, so the same selection always gives the
 * same bytes and the Policy + pinned prefix stays byte-identical between messages.
 */

/** Relevance: `ts_rank_cd + 0.3 · trigram + 0.1 · recency` (SM24). */
export const TRIGRAM_WEIGHT = 0.3;
export const RECENCY_WEIGHT = 0.1;
/** Recency falls linearly from 1 (saved today) to 0 at this age. */
export const RECENCY_DAYS = 180;
/** Base score of a preference in the person and portable lanes. */
export const PREFERENCE_BASE = 0.5;
/** Bonus for an item the thread's previous run was given (in-thread stickiness). */
export const STICKY_BONUS = 0.2;
/** Each lane's floor of rendered bytes (lane header and fences included). */
export const LANE_FLOOR_BYTES = 1024;

/** The four sharing lanes, in floor order (person first, Site last). */
export const SELECT_LANES = ["user", "portable", "team", "site"] as const;
export type SelectLane = (typeof SELECT_LANES)[number];
/** The order the block renders lanes in (Policy is before them all). */
export const RENDER_LANES: readonly SelectLane[] = ["site", "team", "portable", "user"];

/** One candidate as the store reads it, with its relevance parts. */
export interface Candidate {
  readonly item: RunSemanticMemoryItem;
  /** A word of the run's query matched the statement (full text). */
  readonly matched: boolean;
  /** `ts_rank_cd` of the statement against the run's query. */
  readonly textRank: number;
  /** Trigram similarity of the statement and the run's message. */
  readonly trigram: number;
  /** Days since the current version was saved. */
  readonly ageDays: number;
  /** The thread's previous run was given this item. */
  readonly sticky: boolean;
}

export interface SelectInput {
  /** Active Site Policy items (empty when the Site master switch is off). */
  readonly policy: readonly RunSemanticMemoryItem[];
  /** Candidates per enabled lane; a lane that is off is absent. */
  readonly lanes: Partial<Record<SelectLane, readonly Candidate[]>>;
  /**
   * Eligible items per lane beyond the candidates given (the store reads the best ones only);
   * they count as omitted.
   */
  readonly beyond?: Partial<Record<SelectLane, number>>;
  /** Rendered bytes of the whole block (the Site's `context_budget_kib` × 1024). */
  readonly budgetBytes: number;
}

const recency = (ageDays: number) => Math.max(0, 1 - Math.max(0, ageDays) / RECENCY_DAYS);

/** Relevance alone (SM24), without the preference base or stickiness. */
export function relevanceScore(c: Candidate): number {
  return c.textRank + TRIGRAM_WEIGHT * c.trigram + RECENCY_WEIGHT * recency(c.ageDays);
}

/** The score of one candidate in its lane (pure; the SQL ordering mirrors it). */
export function memoryScore(c: Candidate, lane: SelectLane): number {
  const base =
    c.item.kind === "preference" && (lane === "user" || lane === "portable") ? PREFERENCE_BASE : 0;
  return relevanceScore(c) + base + (c.sticky ? STICKY_BONUS : 0);
}

/**
 * A candidate counts at all: pinned, a person-lane preference, or a word of this message's query
 * matched. Stickiness and trigram similarity only rank: an item the previous run got is never a
 * candidate on that alone (re-picked every message, Q6).
 */
export function eligible(c: Candidate, lane: SelectLane): boolean {
  return (
    c.item.pinned ||
    c.matched ||
    (c.item.kind === "preference" && (lane === "user" || lane === "portable"))
  );
}

/** Rendered bytes of one item (Buffer.byteLength: the same UTF-8 count, without an encoder). */
const itemCost = (i: RunSemanticMemoryItem) =>
  SEMANTIC_MEMORY_RENDER_ITEM_OVERHEAD_BYTES + Buffer.byteLength(i.statement, "utf8");

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface Ranked {
  readonly lane: SelectLane;
  readonly item: RunSemanticMemoryItem;
  readonly score: number;
}

/** Pinned first, then score (highest first), then id: one deterministic order. */
const rankOrder = (a: Ranked, b: Ranked) =>
  Number(b.item.pinned) - Number(a.item.pinned) || b.score - a.score || byId(a.item, b.item);

export function selectRunMemory(input: SelectInput): RunSemanticMemory {
  const picked: Ranked[] = [];
  const policy: RunSemanticMemoryItem[] = [];
  const lanesUsed = new Set<string>();
  let spent = SEMANTIC_MEMORY_RENDER_BLOCK_OVERHEAD_BYTES;
  let omitted = 0;
  const count = () => policy.length + picked.length;
  /** Charges `item` when it fits in `limit`; a fence's overhead is paid by its first item. */
  const fits = (item: RunSemanticMemoryItem, limit: number): boolean => {
    if (count() >= SEMANTIC_MEMORY_RUN_MAX_ITEMS) return false;
    // One fence per lane and part (stable or picks), as the sandbox draws it (KOBE-383).
    const fence = semanticMemoryRunFence(item);
    const cost =
      itemCost(item) + (lanesUsed.has(fence) ? 0 : SEMANTIC_MEMORY_RENDER_LANE_OVERHEAD_BYTES);
    if (spent + cost > limit) return false;
    spent += cost;
    lanesUsed.add(fence);
    return true;
  };
  // Policy first, by id, within the budget (the store caps it at 25 items and 2 KiB of
  // statements; at the smallest budget the rendered overheads can still leave some out).
  for (const item of [...input.policy].sort(byId)) {
    if (fits(item, input.budgetBytes)) policy.push(item);
    else omitted += 1;
  }
  const take = (r: Ranked, limit: number): boolean => {
    if (!fits(r.item, limit)) return false;
    picked.push(r);
    return true;
  };
  const queues = new Map<SelectLane, Ranked[]>();
  const pinned: Ranked[] = [];
  let eligibleCount = 0;
  for (const lane of SELECT_LANES) {
    const list = input.lanes[lane];
    if (list === undefined) continue;
    const ranked = list
      .filter((c) => eligible(c, lane))
      .map((c) => ({ lane, item: c.item, score: memoryScore(c, lane) }))
      .sort(rankOrder);
    eligibleCount += ranked.length + (input.beyond?.[lane] ?? 0);
    pinned.push(...ranked.filter((r) => r.item.pinned));
    queues.set(
      lane,
      ranked.filter((r) => !r.item.pinned),
    );
  }
  // Pinned items next, in render order (lane, then id), never by this message's score: the
  // Policy + pinned prefix depends only on what is pinned, so it stays the same between messages.
  for (const r of pinned.sort(stable)) take(r, input.budgetBytes);
  // Floors: each lane in turn fills up to 1 KiB of per-message picks (whole items; a misfit is
  // skipped).
  for (const lane of SELECT_LANES) {
    const queue = queues.get(lane);
    if (queue === undefined) continue;
    const floorEnd = Math.min(input.budgetBytes, spent + LANE_FLOOR_BYTES);
    const rest: Ranked[] = [];
    for (const r of queue) if (!take(r, floorEnd)) rest.push(r);
    queues.set(lane, rest);
  }
  // Flow on: what the floors left goes to the best remaining candidates of any lane.
  const remaining = [...queues.values()].flat().sort(rankOrder);
  for (const r of remaining) take(r, input.budgetBytes);

  const pinnedOut = picked.filter((r) => r.item.pinned).sort(stable);
  const picks = picked.filter((r) => !r.item.pinned).sort(stable);
  return {
    items: [...policy, ...pinnedOut.map((r) => r.item), ...picks.map((r) => r.item)],
    omitted_count: omitted + eligibleCount - picked.length,
  };
}

const laneIndex = (lane: SelectLane) => RENDER_LANES.indexOf(lane);
/** Render order: lane, then id. */
const stable = (a: Ranked, b: Ranked) =>
  laneIndex(a.lane) - laneIndex(b.lane) || byId(a.item, b.item);
