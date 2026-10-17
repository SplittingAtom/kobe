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
 * distinct raters other than the caller, per cell: the totals, each version, each version × model,
 * each reason of a version, and each day. A cell below is withheld (the totals as `enough: false`,
 * the rest left out). Days only, never hours. Time = the rating's last change (`updated_at`).
 */

export interface FeedbackAgent {
  readonly scope: AgentScope;
  readonly id: string;
}

export interface FeedbackRange {
  readonly from: Date;
  readonly to: Date;
}

type Cell = { readonly up: number; readonly down: number; readonly raters: number };

const enough = (c: Cell) => c.raters >= FEEDBACK_MIN_RATERS;

const countsOf = (c: Cell | undefined): FeedbackCounts =>
  c && enough(c)
    ? {
        enough: true,
        up: c.up,
        down: c.down,
        rate: c.up + c.down === 0 ? null : c.up / (c.up + c.down),
      }
    : { enough: false, up: null, down: null, rate: null };

const isReason = (r: string): r is FeedbackReason =>
  (FEEDBACK_REASONS as readonly string[]).includes(r);

export async function agentFeedbackTotals(
  db: KobeDb,
  teamId: string,
  callerId: string,
  agent: FeedbackAgent,
  range: FeedbackRange,
): Promise<AgentFeedbackTotals> {
  const where = sql`team_id = ${teamId} AND agent_id = ${agent.id} AND agent_scope = ${agent.scope}
    AND updated_at >= ${range.from.toISOString()} AND updated_at < ${range.to.toISOString()}`;
  // Distinct raters other than the caller (who can subtract their own ratings anyway).
  const counted = sql`count(*) FILTER (WHERE rating = 'up')::int AS up,
    count(*) FILTER (WHERE rating = 'down')::int AS down,
    count(DISTINCT user_id) FILTER (WHERE user_id <> ${callerId})::int AS raters`;
  const rows = await withTeam(db, teamId, async (tx) => {
    const run = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
      (await tx.execute<T>(q)).rows;
    return {
      total: await run<Cell>(sql`SELECT ${counted} FROM answer_feedback WHERE ${where}`),
      versions: await run<Cell & { version: number | null }>(sql`
        SELECT agent_version AS version, ${counted} FROM answer_feedback WHERE ${where}
         GROUP BY agent_version ORDER BY agent_version DESC NULLS LAST`),
      models: await run<Cell & { version: number | null; model: string | null }>(sql`
        SELECT agent_version AS version, model_alias AS model, ${counted}
          FROM answer_feedback WHERE ${where}
         GROUP BY agent_version, model_alias ORDER BY model_alias NULLS LAST`),
      reasons: await run<{ version: number | null; reason: string; n: number; raters: number }>(sql`
        SELECT agent_version AS version, r AS reason, count(*)::int AS n,
               count(DISTINCT user_id) FILTER (WHERE user_id <> ${callerId})::int AS raters
          FROM answer_feedback, unnest(reasons) AS r
         WHERE ${where} AND rating = 'down'
         GROUP BY agent_version, r`),
      series: await run<Cell & { start: Date | string }>(sql`
        SELECT date_trunc('day', updated_at, 'UTC') AS start, ${counted}
          FROM answer_feedback WHERE ${where}
         GROUP BY 1 ORDER BY 1`),
    };
  });

  const versions = rows.versions.filter(enough).map((v) => {
    const reasons = Object.fromEntries(FEEDBACK_REASONS.map((r) => [r, null])) as Record<
      FeedbackReason,
      number | null
    >;
    for (const r of rows.reasons) {
      if (r.version === v.version && isReason(r.reason) && r.raters >= FEEDBACK_MIN_RATERS) {
        reasons[r.reason] = r.n;
      }
    }
    return {
      version: v.version,
      ...countsOf(v),
      reasons: reasons satisfies FeedbackReasonCounts,
      models: rows.models
        .filter((m) => m.version === v.version && enough(m))
        .map((m) => ({ model: m.model, ...countsOf(m) })),
    };
  });
  return {
    agent_id: agent.id,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    bucket: "day",
    min_raters: FEEDBACK_MIN_RATERS,
    totals: countsOf(rows.total[0]),
    versions,
    series: rows.series
      .filter(enough)
      .map((s) => ({ start: new Date(s.start).toISOString(), up: s.up, down: s.down })),
  };
}
