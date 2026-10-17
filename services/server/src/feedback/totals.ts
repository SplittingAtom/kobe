import {
  FEEDBACK_REASONS,
  type AgentFeedbackTotals,
  type FeedbackCounts,
  type FeedbackReason,
  type FeedbackReasonCounts,
} from "@kobe/protocol";
import { sql, withTeam, type AgentScope, type KobeDb } from "@kobe/db";
import type { UsageRange } from "../models/usage-store.js";

/**
 * Per-version answer feedback totals of one agent in one team (KOBE-275), for its owners and the
 * team's admins. Counts only: the queries select no comment, thread, run, entry or user column, so
 * nothing a member wrote and no member's identity can leave through here (D5/D10: admins never read
 * content outside break-glass). Time = the rating's last change (`updated_at`).
 */

type Counted = { readonly up: number; readonly down: number };

const rateOf = (c: Counted): FeedbackCounts => ({
  up: c.up,
  down: c.down,
  rate: c.up + c.down === 0 ? null : c.up / (c.up + c.down),
});

const emptyReasons = (): Record<FeedbackReason, number> =>
  Object.fromEntries(FEEDBACK_REASONS.map((r) => [r, 0])) as Record<FeedbackReason, number>;

const isReason = (r: string): r is FeedbackReason =>
  (FEEDBACK_REASONS as readonly string[]).includes(r);

export interface FeedbackAgent {
  readonly scope: AgentScope;
  readonly id: string;
}

export async function agentFeedbackTotals(
  db: KobeDb,
  teamId: string,
  agent: FeedbackAgent,
  range: UsageRange,
): Promise<AgentFeedbackTotals> {
  const where = sql`team_id = ${teamId} AND agent_id = ${agent.id} AND agent_scope = ${agent.scope}
    AND updated_at >= ${range.from.toISOString()} AND updated_at < ${range.to.toISOString()}`;
  const unit = sql.raw(`'${range.bucket}'`);
  const { byModel, reasons, series } = await withTeam(db, teamId, async (tx) => {
    const byModel = await tx.execute<{
      version: number | null;
      model: string | null;
      up: number;
      down: number;
    }>(sql`
      SELECT agent_version AS version, model_alias AS model,
             count(*) FILTER (WHERE rating = 'up')::int AS up,
             count(*) FILTER (WHERE rating = 'down')::int AS down
        FROM answer_feedback WHERE ${where}
       GROUP BY agent_version, model_alias
       ORDER BY agent_version DESC NULLS LAST, model_alias NULLS LAST`);
    const reasons = await tx.execute<{ version: number | null; reason: string; n: number }>(sql`
      SELECT agent_version AS version, r AS reason, count(*)::int AS n
        FROM answer_feedback, unnest(reasons) AS r
       WHERE ${where} AND rating = 'down'
       GROUP BY agent_version, r`);
    const series = await tx.execute<{ start: Date | string; up: number; down: number }>(sql`
      SELECT date_trunc(${unit}, updated_at, 'UTC') AS start,
             count(*) FILTER (WHERE rating = 'up')::int AS up,
             count(*) FILTER (WHERE rating = 'down')::int AS down
        FROM answer_feedback WHERE ${where}
       GROUP BY 1 ORDER BY 1`);
    return { byModel: byModel.rows, reasons: reasons.rows, series: series.rows };
  });

  const versions = new Map<
    number | null,
    { up: number; down: number; reasons: Record<FeedbackReason, number> }
  >();
  const versionOf = (v: number | null) => {
    const existing = versions.get(v);
    if (existing) return existing;
    const created = { up: 0, down: 0, reasons: emptyReasons() };
    versions.set(v, created);
    return created;
  };
  const models = new Map<number | null, { model: string | null; up: number; down: number }[]>();
  for (const row of byModel) {
    const v = versionOf(row.version);
    v.up += row.up;
    v.down += row.down;
    models.set(row.version, [...(models.get(row.version) ?? []), row]);
  }
  for (const row of reasons) {
    if (isReason(row.reason)) versionOf(row.version).reasons[row.reason] += row.n;
  }
  const total = [...versions.values()].reduce<Counted>(
    (acc, v) => ({ up: acc.up + v.up, down: acc.down + v.down }),
    { up: 0, down: 0 },
  );
  return {
    agent_id: agent.id,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    bucket: range.bucket,
    totals: rateOf(total),
    versions: [...versions.entries()].map(([version, v]) => ({
      version,
      ...rateOf(v),
      reasons: v.reasons satisfies FeedbackReasonCounts,
      models: (models.get(version) ?? []).map((m) => ({ model: m.model, ...rateOf(m) })),
    })),
    series: series.map((s) => ({
      start: new Date(s.start).toISOString(),
      up: s.up,
      down: s.down,
    })),
  };
}
