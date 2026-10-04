import { addCosts, costForDisplay, costToUnits } from "./usage-cost.js";
import { scanTeams, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";

/**
 * Usage dashboards and run details (KOBE-43, spec D30): aggregates of the `run_usage` ledger
 * (written by the model-gateway shim). Team views run inside the team's RLS transaction; the
 * install view visits every team with `scanTeams` (no RLS bypass) and adds them up. Only ids,
 * names and counts leave here: never thread titles or content (install admins cannot read team
 * content, D8; team admins do not see members' threads).
 */
export type Bucket = "hour" | "day";

export interface UsageRange {
  readonly from: Date;
  readonly to: Date;
  readonly bucket: Bucket;
}

export interface UsageTotals {
  readonly calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  /** Dollars of the priced calls, for display (a float parsed from `cost_usd_exact`). */
  readonly cost_usd: number;
  /** The same sum as exact numeric text (10 decimals); what budgets and sums must use. */
  readonly cost_usd_exact: string;
  /** Calls whose model had no catalog price (tokens counted, cost unknown). */
  readonly unpriced_calls: number;
  /** Calls whose tokens the gateway estimated (no usage report from the provider). */
  readonly estimated_calls: number;
}

export interface SeriesPoint extends UsageTotals {
  readonly t: string;
}

export interface UserUsage extends UsageTotals {
  readonly user_id: string;
  readonly name: string | null;
  readonly email: string | null;
}

export interface ModelUsage extends UsageTotals {
  readonly model: string;
}

export interface AgentUsage extends UsageTotals {
  /** Null: chats with the install default agent (no agent pinned) or calls outside a run. */
  readonly agent_id: string | null;
  readonly slug: string | null;
  readonly scope: "team" | "personal" | "gallery" | null;
}

export interface TeamUsageReport {
  readonly range: { readonly from: string; readonly to: string; readonly bucket: Bucket };
  readonly totals: UsageTotals;
  readonly series: readonly SeriesPoint[];
  readonly by_user: readonly UserUsage[];
  readonly by_model: readonly ModelUsage[];
  readonly by_agent: readonly AgentUsage[];
}

export interface TeamUsageSummary extends UsageTotals {
  readonly team_id: string;
  readonly slug: string;
  readonly name: string;
}

export interface InstallUsageReport extends TeamUsageReport {
  readonly by_team: readonly TeamUsageSummary[];
}

/** Longest list returned per breakdown (largest cost first, then tokens). */
export const BREAKDOWN_LIMIT = 50;

const ZERO_COST = "0.0000000000";

const EMPTY: UsageTotals = {
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
  cost_usd_exact: ZERO_COST,
  unpriced_calls: 0,
  estimated_calls: 0,
};

/** The aggregate columns every breakdown selects (same names as {@link UsageTotals}). */
const TOTALS = sql.raw(`count(*)::bigint AS calls,
  COALESCE(sum(u.input_tokens), 0)::bigint AS input_tokens,
  COALESCE(sum(u.output_tokens), 0)::bigint AS output_tokens,
  COALESCE(sum(u.cache_read_tokens), 0)::bigint AS cache_read_tokens,
  COALESCE(sum(u.cache_write_tokens), 0)::bigint AS cache_write_tokens,
  COALESCE(sum(u.cost_usd), 0)::numeric(30,10)::text AS cost_usd,
  count(*) FILTER (WHERE u.cost_usd IS NULL)::bigint AS unpriced_calls,
  count(*) FILTER (WHERE u.usage_source = 'estimated')::bigint AS estimated_calls`);
const ORDER = sql.raw(
  `ORDER BY COALESCE(sum(u.cost_usd), 0) DESC, sum(u.input_tokens + u.output_tokens) DESC`,
);

type Row = Record<string, unknown>;

function totalsOf(r: Row | undefined): UsageTotals {
  if (!r) return EMPTY;
  const exact = unitsToCostText(r.cost_usd);
  return {
    calls: Number(r.calls ?? 0),
    input_tokens: Number(r.input_tokens ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
    cache_read_tokens: Number(r.cache_read_tokens ?? 0),
    cache_write_tokens: Number(r.cache_write_tokens ?? 0),
    cost_usd: costForDisplay(exact),
    cost_usd_exact: exact,
    unpriced_calls: Number(r.unpriced_calls ?? 0),
    estimated_calls: Number(r.estimated_calls ?? 0),
  };
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const exact = addCosts(a.cost_usd_exact, b.cost_usd_exact);
  return {
    calls: a.calls + b.calls,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    cost_usd: costForDisplay(exact),
    cost_usd_exact: exact,
    unpriced_calls: a.unpriced_calls + b.unpriced_calls,
    estimated_calls: a.estimated_calls + b.estimated_calls,
  };
}

/** The query's numeric text (or nothing) as a normalised exact cost. */
const unitsToCostText = (v: unknown): string =>
  addCosts(ZERO_COST, v == null ? ZERO_COST : String(v));

const compareCost = (a: UsageTotals, b: UsageTotals): number => {
  const d = costToUnits(b.cost_usd_exact) - costToUnits(a.cost_usd_exact);
  return d > 0n ? 1 : d < 0n ? -1 : 0;
};

const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

/** Every aggregate of one team for the range (inside its withTeam transaction). */
async function teamReport(
  tx: KobeTx,
  teamId: string,
  range: UsageRange,
  limit: number | null = BREAKDOWN_LIMIT,
): Promise<Omit<TeamUsageReport, "range">> {
  // The install view merges teams first and limits after, so it reads every group.
  const LIMIT = limit === null ? sql`` : sql`LIMIT ${limit}`;
  const where = sql`u.team_id = ${teamId}::uuid AND u.at >= ${range.from.toISOString()}::timestamptz
    AND u.at < ${range.to.toISOString()}::timestamptz`;
  const bucket = sql.raw(`'${range.bucket}'`);
  // One connection per transaction: the queries run one after another.
  const totals = await tx.execute<Row>(sql`SELECT ${TOTALS} FROM run_usage u WHERE ${where}`);
  const series = await tx.execute<Row>(sql`
    SELECT date_trunc(${bucket}, u.at, 'UTC') AS t, ${TOTALS}
      FROM run_usage u WHERE ${where} GROUP BY 1 ORDER BY 1`);
  const users = await tx.execute<Row>(sql`
    SELECT u.user_id, max(us.name) AS name, max(us.email) AS email, ${TOTALS}
      FROM run_usage u LEFT JOIN users us ON us.id = u.user_id
     WHERE ${where} GROUP BY u.user_id ${ORDER} ${LIMIT}`);
  const models = await tx.execute<Row>(sql`
    SELECT u.model, ${TOTALS} FROM run_usage u WHERE ${where}
     GROUP BY u.model ${ORDER} ${LIMIT}`);
  const agents = await tx.execute<Row>(sql`
    SELECT u.agent_id,
           COALESCE(max(ta.slug), max(ia.slug)) AS slug,
           CASE WHEN max(ta.slug) IS NOT NULL THEN 'team' ELSE max(ia.scope::text) END AS scope,
           ${TOTALS}
      FROM run_usage u
      LEFT JOIN team_agents ta ON ta.team_id = u.team_id AND ta.id = u.agent_id
      LEFT JOIN install_agents ia ON ia.id = u.agent_id
     WHERE ${where} GROUP BY u.agent_id ${ORDER} ${LIMIT}`);
  return {
    totals: totalsOf(totals.rows[0]),
    series: series.rows.map((r) => ({ t: iso(r.t), ...totalsOf(r) })),
    by_user: users.rows.map((r) => ({
      user_id: String(r.user_id),
      name: (r.name as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      ...totalsOf(r),
    })),
    by_model: models.rows.map((r) => ({ model: String(r.model), ...totalsOf(r) })),
    by_agent: agents.rows.map((r) => ({
      agent_id: (r.agent_id as string | null) ?? null,
      slug: (r.slug as string | null) ?? null,
      scope: (r.scope as AgentUsage["scope"]) ?? null,
      ...totalsOf(r),
    })),
  };
}

const rangeView = (r: UsageRange) => ({
  from: r.from.toISOString(),
  to: r.to.toISOString(),
  bucket: r.bucket,
});

export async function teamUsage(
  db: KobeDb,
  teamId: string,
  range: UsageRange,
): Promise<TeamUsageReport> {
  const report = await withTeam(db, teamId, (tx) => teamReport(tx, teamId, range));
  return { range: rangeView(range), ...report };
}

function mergeBy<T extends UsageTotals>(
  lists: readonly (readonly T[])[],
  key: (item: T) => string,
  limit = BREAKDOWN_LIMIT,
): T[] {
  const merged = new Map<string, T>();
  for (const list of lists) {
    for (const item of list) {
      const k = key(item);
      const prev = merged.get(k);
      merged.set(k, prev ? { ...prev, ...addTotals(prev, item) } : item);
    }
  }
  return [...merged.values()]
    .sort(
      (a, b) =>
        compareCost(a, b) || b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens),
    )
    .slice(0, limit);
}

/**
 * The install's usage: every team's report (one RLS transaction visiting each team), summed.
 * Per-agent rows are summed by agent id; a user in several teams is one row.
 */
export async function installUsage(db: KobeDb, range: UsageRange): Promise<InstallUsageReport> {
  const teams = await scanTeams(db, "installUsage", async (tx, team) => ({
    team,
    report: await teamReport(tx, team.id, range, null),
  }));
  const totals = teams.reduce((acc, t) => addTotals(acc, t.report.totals), EMPTY);
  return {
    range: rangeView(range),
    totals,
    series: mergeBy(
      teams.map((t) => t.report.series),
      (p) => p.t,
      Number.MAX_SAFE_INTEGER,
    ).sort((a, b) => a.t.localeCompare(b.t)),
    by_user: mergeBy(
      teams.map((t) => t.report.by_user),
      (u) => u.user_id,
    ),
    by_model: mergeBy(
      teams.map((t) => t.report.by_model),
      (m) => m.model,
    ),
    by_agent: mergeBy(
      teams.map((t) => t.report.by_agent),
      (a) => `${a.scope ?? ""}:${a.agent_id ?? ""}`,
    ),
    by_team: teams
      .map((t) => ({
        team_id: t.team.id,
        slug: t.team.slug,
        name: t.team.name,
        ...t.report.totals,
      }))
      .filter((t) => t.calls > 0)
      .sort((a, b) => compareCost(a, b) || b.calls - a.calls),
  };
}

export interface RunUsage extends UsageTotals {
  readonly run_id: string;
  readonly models: readonly string[];
}

/** Per-run usage of one run, or of every run of a thread (runs without calls are omitted). */
export async function runsUsage(
  db: KobeDb,
  teamId: string,
  of: { readonly runId: string } | { readonly threadId: string },
): Promise<RunUsage[]> {
  return withTeam(db, teamId, async (tx) => {
    const filter =
      "runId" in of ? sql`u.run_id = ${of.runId}::uuid` : sql`u.thread_id = ${of.threadId}::uuid`;
    const res = await tx.execute<Row>(sql`
      SELECT u.run_id, array_agg(DISTINCT u.model ORDER BY u.model) AS models, ${TOTALS}
        FROM run_usage u
       WHERE u.team_id = ${teamId}::uuid AND ${filter}
       GROUP BY u.run_id ORDER BY min(u.at)`);
    return res.rows.map((r) => ({
      run_id: String(r.run_id),
      models: (r.models as string[] | null) ?? [],
      ...totalsOf(r),
    }));
  });
}
