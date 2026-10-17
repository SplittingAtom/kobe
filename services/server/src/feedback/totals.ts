import {
  FEEDBACK_MIN_RATERS,
  FEEDBACK_REASONS,
  type AgentFeedbackTotals,
  type FeedbackCounts,
  type FeedbackReason,
  type FeedbackReasonCounts,
} from "@kobe/protocol";
import { sql, withTeam, type AgentScope, type KobeDb } from "@kobe/db";

/**
 * Per-version answer feedback totals of one agent in one team (KOBE-275), for its owners and the
 * team's admins. Counts only: the queries select no comment, thread, run or entry column and return
 * no user id, so nothing a member wrote and no member's identity leaves through here (D5/D10: admins
 * never read content outside break-glass).
 *
 * Small numbers single people out (review S1: a personal agent shared with one colleague shows that
 * colleague's ratings exactly), so every number stands on at least {@link FEEDBACK_MIN_RATERS}
 * distinct raters other than the caller (who can subtract their own ratings anyway):
 * - totals below it show `enough: false`, and nothing is broken down;
 * - a breakdown (the versions, a version's models, a version's reasons, the days) is shown only
 *   when every one of its non-empty cells passes, so a withheld cell is never the total minus the
 *   shown ones (review R2);
 * - the range is whole UTC days ending at the start of today ({@link wholeDays}, review R1).
 * Time = the rating's last change (`updated_at`).
 */

export interface FeedbackAgent {
  readonly scope: AgentScope;
  readonly id: string;
}

export interface FeedbackRange {
  readonly from: Date;
  readonly to: Date;
}

const DAY_MS = 86_400_000;
const dayFloor = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;
const dayCeil = (t: number) => (t % DAY_MS === 0 ? t : dayFloor(t) + DAY_MS);

/**
 * The range in whole UTC days, ending at the start of today at the latest (review R1): `from`
 * down to midnight, `to` up to midnight, then capped at today's. Two queries thus never differ by
 * less than a finished day, and a rating counts only once its day is over. Feedback totals only:
 * the usage dashboards keep their own ranges.
 */
export function wholeDays(range: FeedbackRange, now = new Date()): FeedbackRange {
  const from = dayFloor(range.from.getTime());
  const to = Math.max(from, Math.min(dayCeil(range.to.getTime()), dayFloor(now.getTime())));
  return { from: new Date(from), to: new Date(to) };
}

type Cell = { readonly up: number; readonly down: number; readonly raters: number };

const enough = (c: { readonly raters: number }) => c.raters >= FEEDBACK_MIN_RATERS;

/** The cells, or null unless every one stands on enough raters. */
function whole<T extends { readonly raters: number }>(cells: readonly T[]): readonly T[] | null {
  return cells.every(enough) ? cells : null;
}

const shown = (c: Cell) => ({
  up: c.up,
  down: c.down,
  rate: c.up + c.down === 0 ? null : c.up / (c.up + c.down),
});

const isReason = (r: string): r is FeedbackReason =>
  (FEEDBACK_REASONS as readonly string[]).includes(r);

type Rows = {
  readonly total: Cell | undefined;
  readonly versions: readonly (Cell & { readonly version: number | null })[];
  readonly models: readonly (Cell & {
    readonly version: number | null;
    readonly model: string | null;
  })[];
  readonly reasons: readonly {
    readonly version: number | null;
    readonly reason: string;
    readonly n: number;
    readonly raters: number;
  }[];
  readonly series: readonly (Cell & { readonly start: Date | string })[];
};

async function readRows(
  db: KobeDb,
  teamId: string,
  callerId: string,
  agent: FeedbackAgent,
  range: FeedbackRange,
): Promise<Rows> {
  const where = sql`team_id = ${teamId} AND agent_id = ${agent.id} AND agent_scope = ${agent.scope}
    AND updated_at >= ${range.from.toISOString()} AND updated_at < ${range.to.toISOString()}`;
  const raters = sql`count(DISTINCT user_id) FILTER (WHERE user_id <> ${callerId})::int AS raters`;
  const counted = sql`count(*) FILTER (WHERE rating = 'up')::int AS up,
    count(*) FILTER (WHERE rating = 'down')::int AS down, ${raters}`;
  return withTeam(db, teamId, async (tx) => {
    const run = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
      (await tx.execute<T>(q)).rows;
    const total = await run<Cell>(sql`SELECT ${counted} FROM answer_feedback WHERE ${where}`);
    return {
      total: total[0],
      versions: await run<Cell & { version: number | null }>(sql`
        SELECT agent_version AS version, ${counted} FROM answer_feedback WHERE ${where}
         GROUP BY agent_version ORDER BY agent_version DESC NULLS LAST`),
      models: await run<Cell & { version: number | null; model: string | null }>(sql`
        SELECT agent_version AS version, model_alias AS model, ${counted}
          FROM answer_feedback WHERE ${where}
         GROUP BY agent_version, model_alias ORDER BY model_alias NULLS LAST`),
      reasons: await run<{ version: number | null; reason: string; n: number; raters: number }>(sql`
        SELECT agent_version AS version, r AS reason, count(*)::int AS n, ${raters}
          FROM answer_feedback, unnest(reasons) AS r
         WHERE ${where} AND rating = 'down'
         GROUP BY agent_version, r`),
      series: await run<Cell & { start: Date | string }>(sql`
        SELECT date_trunc('day', updated_at, 'UTC') AS start, ${counted}
          FROM answer_feedback WHERE ${where}
         GROUP BY 1 ORDER BY 1`),
    };
  });
}

function reasonsOf(rows: Rows, version: number | null): FeedbackReasonCounts | null {
  const given = whole(rows.reasons.filter((r) => r.version === version && isReason(r.reason)));
  if (!given) return null;
  return Object.fromEntries(
    FEEDBACK_REASONS.map((r) => [r, given.find((g) => g.reason === r)?.n ?? 0]),
  ) as FeedbackReasonCounts;
}

export async function agentFeedbackTotals(
  db: KobeDb,
  teamId: string,
  callerId: string,
  agent: FeedbackAgent,
  range: FeedbackRange,
): Promise<AgentFeedbackTotals> {
  const rows = await readRows(db, teamId, callerId, agent, range);
  const base = {
    agent_id: agent.id,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    bucket: "day" as const,
    min_raters: FEEDBACK_MIN_RATERS,
  };
  if (!rows.total || !enough(rows.total)) {
    const withheld: FeedbackCounts = { enough: false, up: null, down: null, rate: null };
    return { ...base, totals: withheld, versions: null, series: null };
  }
  const versions =
    whole(rows.versions)?.map((v) => {
      const models = whole(rows.models.filter((m) => m.version === v.version));
      return {
        version: v.version,
        ...shown(v),
        reasons: reasonsOf(rows, v.version),
        models: models?.map((m) => ({ model: m.model, ...shown(m) })) ?? null,
      };
    }) ?? null;
  const series =
    whole(rows.series)?.map((d) => ({
      start: new Date(d.start).toISOString(),
      up: d.up,
      down: d.down,
    })) ?? null;
  return { ...base, totals: { enough: true, ...shown(rows.total) }, versions, series };
}
