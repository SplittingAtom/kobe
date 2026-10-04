import { sql } from "drizzle-orm";
import type { KobeTx } from "../client.js";
import {
  DEFAULT_REQUESTS_PER_MINUTE,
  type BudgetPeriod,
  type BudgetScope,
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
  readonly limitUsd: number;
  readonly spentUsd: number;
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
  line.limitUsd <= 0 ? 100 : (line.spentUsd / line.limitUsd) * 100;

/** The used-up budget that stops calls and runs (widest scope first), or undefined. */
export function exhaustedLine(lines: readonly BudgetLine[]): BudgetLine | undefined {
  return [...lines]
    .filter((l) => l.spentUsd >= l.limitUsd)
    .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope])[0];
}

type Row = Record<string, unknown>;
const num = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Number(v);

interface Limits {
  readonly monthly: number | undefined;
  readonly daily: number | undefined;
}

function linesOf(
  scope: BudgetScope,
  userId: string | undefined,
  limits: Limits,
  spent: { readonly month: number; readonly day: number },
  starts: { readonly month: string; readonly day: string },
): BudgetLine[] {
  const out: BudgetLine[] = [];
  if (limits.monthly !== undefined) {
    out.push({
      scope,
      userId,
      period: "month",
      periodStart: starts.month,
      limitUsd: limits.monthly,
      spentUsd: spent.month,
    });
  }
  if (limits.daily !== undefined) {
    out.push({
      scope,
      userId,
      period: "day",
      periodStart: starts.day,
      limitUsd: limits.daily,
      spentUsd: spent.day,
    });
  }
  return out;
}

/** The install limits and the install's spend this month and today (any team context). */
async function installPart(
  tx: KobeTx,
  starts: { readonly month: string; readonly day: string },
): Promise<{ limits: Limits; rpm: number; spent: { month: number; day: number } }> {
  const res = await tx.execute<Row>(sql`
    SELECT l.monthly_usd, l.daily_usd, l.user_requests_per_minute,
           (SELECT COALESCE(sum(cost_usd), 0) FROM install_model_spend_daily
             WHERE day >= ${starts.month}::date) AS month,
           (SELECT COALESCE(sum(cost_usd), 0) FROM install_model_spend_daily
             WHERE day = ${starts.day}::date) AS day
      FROM install_model_limits l WHERE l.id = 1`);
  const r = res.rows[0] ?? {};
  return {
    limits: { monthly: num(r.monthly_usd), daily: num(r.daily_usd) },
    rpm: num(r.user_requests_per_minute) ?? DEFAULT_REQUESTS_PER_MINUTE,
    spent: { month: num(r.month) ?? 0, day: num(r.day) ?? 0 },
  };
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
    SELECT b.user_id, b.monthly_usd, b.daily_usd, b.user_requests_per_minute,
           COALESCE((SELECT sum(s.cost_usd) FROM model_spend_daily s
                      WHERE s.team_id = b.team_id AND s.day >= ${starts.month}::date
                        AND (b.user_id IS NULL OR s.user_id = b.user_id)), 0) AS month,
           COALESCE((SELECT sum(s.cost_usd) FROM model_spend_daily s
                      WHERE s.team_id = b.team_id AND s.day = ${starts.day}::date
                        AND (b.user_id IS NULL OR s.user_id = b.user_id)), 0) AS day
      FROM team_budgets b
     WHERE b.team_id = ${teamId}::uuid
       ${member === undefined ? sql`` : sql`AND (b.user_id IS NULL OR b.user_id = ${member}::uuid)`}`);
  const lines = linesOf("install", undefined, install.limits, install.spent, starts);
  let rpm = install.rpm;
  for (const r of budgets.rows) {
    const userId = (r.user_id as string | null) ?? undefined;
    const teamRpm = num(r.user_requests_per_minute);
    if (userId === undefined && teamRpm !== undefined) rpm = Math.min(rpm, teamRpm);
    lines.push(
      ...linesOf(
        userId ? "user" : "team",
        userId,
        { monthly: num(r.monthly_usd), daily: num(r.daily_usd) },
        { month: num(r.month) ?? 0, day: num(r.day) ?? 0 },
        starts,
      ),
    );
  }
  return { lines, requestsPerMinute: rpm };
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
