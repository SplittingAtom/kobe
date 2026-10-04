import { sql } from "drizzle-orm";
import type { KobeDb, KobeTx } from "../client.js";
import {
  DEFAULT_REQUESTS_PER_MINUTE,
  type BudgetPeriod,
  type BudgetScope,
  type BudgetUnit,
} from "../schema/budgets.js";

/**
 * Budget state for one member of one team (KOBE-42, D30), read inside that team's transaction:
 * every budget that applies (install, team, the member's own), each with its period's spend, and
 * the member's request rate. Spend comes from the daily counters the `run_usage` trigger keeps.
 * Shared by the model-gateway's call gate, the run orchestrator's new-run gate and the server's
 * budget monitor, so all three judge the same numbers.
 */
export interface BudgetLine {
  readonly scope: BudgetScope;
  /** Set for a user-in-team budget. */
  readonly userId: string | undefined;
  readonly period: BudgetPeriod;
  /** First day of the period (UTC, `YYYY-MM-DD`). */
  readonly periodStart: string;
  /** Dollars at catalog prices, or tokens (input + output + cache reads + cache writes). */
  readonly unit: BudgetUnit;
  readonly limit: number;
  readonly spent: number;
}

export interface MemberBudgetState {
  readonly lines: readonly BudgetLine[];
  /** Effective per-user requests per minute (the install's, or the team's lower one). */
  readonly requestsPerMinute: number;
}

/** UTC period starts for `now`. */
export function periodStarts(now: Date): { readonly month: string; readonly day: string } {
  const day = now.toISOString().slice(0, 10);
  return { month: `${day.slice(0, 8)}01`, day };
}

/** Scopes from the widest: a stop names the widest budget that is used up. */
const SCOPE_ORDER: Readonly<Record<BudgetScope, number>> = { install: 0, team: 1, user: 2 };

/** Percent of the limit spent; a zero budget counts as used up (it allows nothing). */
export const percentUsed = (line: BudgetLine): number =>
  line.limit <= 0 ? 100 : (line.spent / line.limit) * 100;

/** The used-up budget that stops calls and runs (widest scope first), or undefined. */
export function exhaustedLine(lines: readonly BudgetLine[]): BudgetLine | undefined {
  return [...lines]
    .filter((l) => l.spent >= l.limit)
    .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope])[0];
}

type Row = Record<string, unknown>;
const num = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Number(v);

/** A row's limits and spend: `monthly_usd`, `daily_usd`, `monthly_tokens`, `daily_tokens`, and
 * `month_usd`, `day_usd`, `month_tokens`, `day_tokens`. */
function linesOf(
  scope: BudgetScope,
  userId: string | undefined,
  r: Row,
  starts: { readonly month: string; readonly day: string },
): BudgetLine[] {
  const out: BudgetLine[] = [];
  for (const unit of ["usd", "tokens"] as const) {
    for (const [period, limitKey, spentKey] of [
      ["month", `monthly_${unit}`, `month_${unit}`],
      ["day", `daily_${unit}`, `day_${unit}`],
    ] as const) {
      const limit = num(r[limitKey]);
      if (limit === undefined) continue;
      out.push({
        scope,
        userId,
        period,
        periodStart: period === "month" ? starts.month : starts.day,
        unit,
        limit,
        spent: num(r[spentKey]) ?? 0,
      });
    }
  }
  return out;
}

/** Spend columns over a daily counter table aliased `s` (`filter` narrows it). */
const spendColumns = (starts: { month: string; day: string }) =>
  sql`COALESCE(sum(s.cost_usd) FILTER (WHERE s.day >= ${starts.month}::date), 0) AS month_usd,
      COALESCE(sum(s.cost_usd) FILTER (WHERE s.day = ${starts.day}::date), 0) AS day_usd,
      COALESCE(sum(s.tokens) FILTER (WHERE s.day >= ${starts.month}::date), 0) AS month_tokens,
      COALESCE(sum(s.tokens) FILTER (WHERE s.day = ${starts.day}::date), 0) AS day_tokens`;

/** The install limits and the install's spend this month and today (any team context). */
async function installPart(
  tx: KobeTx,
  starts: { readonly month: string; readonly day: string },
): Promise<{ row: Row; rpm: number }> {
  const res = await tx.execute<Row>(sql`
    SELECT l.monthly_usd, l.daily_usd, l.monthly_tokens, l.daily_tokens,
           l.user_requests_per_minute, sp.*
      FROM install_model_limits l,
           LATERAL (SELECT ${spendColumns(starts)} FROM install_model_spend_daily s
                     WHERE s.day >= ${starts.month}::date) sp
     WHERE l.id = 1`);
  const row = res.rows[0] ?? {};
  return { row, rpm: num(row.user_requests_per_minute) ?? DEFAULT_REQUESTS_PER_MINUTE };
}

/**
 * Every budget line of one team: install, team, and each member budget (with that member's spend).
 * Must run inside the team's transaction (`withTeam`).
 */
export function loadTeamBudgetLines(
  tx: KobeTx,
  teamId: string,
  now = new Date(),
): Promise<{ readonly lines: readonly BudgetLine[]; readonly requestsPerMinute: number }> {
  return budgetLines(tx, teamId, undefined, now);
}

async function budgetLines(
  tx: KobeTx,
  teamId: string,
  member: string | undefined,
  now: Date,
): Promise<{ readonly lines: readonly BudgetLine[]; readonly requestsPerMinute: number }> {
  const starts = periodStarts(now);
  const install = await installPart(tx, starts);
  const budgets = await tx.execute<Row>(sql`
    SELECT b.user_id, b.monthly_usd, b.daily_usd, b.monthly_tokens, b.daily_tokens,
           b.member_monthly_usd, b.member_daily_usd, b.member_monthly_tokens, b.member_daily_tokens,
           b.user_requests_per_minute, sp.*
      FROM team_budgets b,
           LATERAL (SELECT ${spendColumns(starts)} FROM model_spend_daily s
                     WHERE s.team_id = b.team_id AND s.day >= ${starts.month}::date
                       AND (b.user_id IS NULL OR s.user_id = b.user_id)) sp
     WHERE b.team_id = ${teamId}::uuid
       ${member === undefined ? sql`` : sql`AND (b.user_id IS NULL OR b.user_id = ${member}::uuid)`}`);
  const lines = linesOf("install", undefined, install.row, starts);
  let rpm = install.rpm;
  const own = new Set<string>();
  let defaults: Row | undefined;
  for (const r of budgets.rows) {
    const userId = (r.user_id as string | null) ?? undefined;
    const teamRpm = num(r.user_requests_per_minute);
    if (userId === undefined && teamRpm !== undefined) rpm = Math.min(rpm, teamRpm);
    if (userId === undefined) defaults = memberDefaults(r);
    else own.add(userId);
    lines.push(...linesOf(userId ? "user" : "team", userId, r, starts));
  }
  if (defaults) {
    // The team's default member budget: every member without a budget of their own (for the
    // whole team, those who spent this period; members with no spend are under any budget).
    const spenders = await tx.execute<Row>(sql`
      SELECT s.user_id, ${spendColumns(starts)} FROM model_spend_daily s
       WHERE s.team_id = ${teamId}::uuid AND s.day >= ${starts.month}::date
         ${member === undefined ? sql`` : sql`AND s.user_id = ${member}::uuid`}
       GROUP BY s.user_id`);
    const rows =
      spenders.rows.length > 0 || member === undefined ? spenders.rows : [{ user_id: member }];
    for (const r of rows) {
      const userId = String(r.user_id);
      if (own.has(userId)) continue;
      lines.push(...linesOf("user", userId, { ...r, ...defaults }, starts));
    }
  }
  return { lines, requestsPerMinute: rpm };
}

/** The team row's default member budget as a budget row (undefined when it sets none). */
function memberDefaults(r: Row): Row | undefined {
  const d = {
    monthly_usd: r.member_monthly_usd,
    daily_usd: r.member_daily_usd,
    monthly_tokens: r.member_monthly_tokens,
    daily_tokens: r.member_daily_tokens,
  };
  return Object.values(d).some((v) => v !== null && v !== undefined) ? d : undefined;
}

/** The lines that apply to one member: install, team and their own (inside `withTeam`). */
export async function loadMemberBudgetState(
  tx: KobeTx,
  teamId: string,
  userId: string,
  now = new Date(),
): Promise<MemberBudgetState> {
  return budgetLines(tx, teamId, userId, now);
}

export interface ModelPrice {
  /** Dollars per million input / output tokens. */
  readonly input: number;
  readonly output: number;
}

/**
 * Catalog prices by gateway model (`<gateway provider>/<model>`; the highest of several aliases),
 * for the model gateway's in-flight budget reservations (KOBE-42 review). Unpriced models are
 * absent (their calls reserve tokens only).
 */
export async function loadGatewayPrices(
  db: KobeDb | KobeTx,
): Promise<ReadonlyMap<string, ModelPrice>> {
  const res = await db.execute<Row>(sql`
    SELECT (CASE WHEN p.kind = 'openai_compatible' THEN 'kobe-' || p.id ELSE p.kind::text END)
             || '/' || c.model AS model,
           max(c.input_usd_per_mtok) AS input, max(c.output_usd_per_mtok) AS output
      FROM model_catalog c JOIN model_providers p ON p.id = c.provider_id
     WHERE c.input_usd_per_mtok IS NOT NULL AND c.output_usd_per_mtok IS NOT NULL
     GROUP BY 1`);
  return new Map(
    res.rows.map((r) => [String(r.model), { input: Number(r.input), output: Number(r.output) }]),
  );
}
