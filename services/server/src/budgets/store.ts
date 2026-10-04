import {
  MODELS_BUDGETS_PREFIX,
  and,
  bumpModelsConfig,
  eq,
  installModelLimits,
  isNull,
  loadMemberBudgetState,
  notifyModels,
  percentUsed,
  periodStarts,
  sql,
  teamBudgets,
  teamMembers,
  users,
  withTeam,
  type BudgetLine,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Budgets and rate limits (KOBE-42, spec D6, D8, D30): the install's (install admins) and the
 * team's and members' (team admins), every change audited (`models.budget.changed`) and hinted to
 * the model-gateway shims (`budgets:<team|*>`). A change of the per-user request rate also bumps
 * the gateway's desired version, so the sync pushes the virtual keys' rate limits to Bifrost.
 */
/** Dollar and token budgets (user decision 2026-10-04: tokens cap models without prices). */
export interface BudgetAmounts {
  readonly monthly_usd: number | null;
  readonly daily_usd: number | null;
  readonly monthly_tokens: number | null;
  readonly daily_tokens: number | null;
}

export interface InstallLimitsView extends BudgetAmounts {
  readonly user_requests_per_minute: number;
  readonly updated_at: string;
}

export interface SpendView {
  readonly month_usd: number;
  readonly day_usd: number;
  /** Input + output + cache read + cache write tokens. */
  readonly month_tokens: number;
  readonly day_tokens: number;
}

export interface MemberBudgetView extends BudgetAmounts {
  readonly user_id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly spent: SpendView;
}

export interface TeamBudgetsView {
  readonly period: { readonly month: string; readonly day: string };
  /**
   * The install budget's limits and how much of it is used, in percent only: the install's spend is
   * every team's together, which a team does not see in dollars.
   */
  readonly install: {
    readonly user_requests_per_minute: number;
    /** Null where the install sets no such budget. */
    readonly percent_used: {
      readonly month_usd: number | null;
      readonly day_usd: number | null;
      readonly month_tokens: number | null;
      readonly day_tokens: number | null;
    };
  };
  readonly team: BudgetAmounts & {
    readonly user_requests_per_minute: number | null;
    readonly spent: SpendView;
    /** The default budget of every member without one of their own (KOBE-42 review). */
    readonly member_default: BudgetAmounts;
  };
  /** The per-user request rate members get (the install's, or the team's lower one). */
  readonly effective_requests_per_minute: number;
  readonly members: readonly MemberBudgetView[];
}

type Row = Record<string, unknown>;

const percentOf = (spent: number, limit: number | null): number | null =>
  limit === null ? null : limit <= 0 ? 100 : Math.min(100, Math.round((spent / limit) * 100));

export async function getInstallLimits(db: KobeDb | KobeTx): Promise<InstallLimitsView> {
  const [row] = await db.select().from(installModelLimits).where(eq(installModelLimits.id, 1));
  return {
    monthly_usd: row?.monthlyUsd ?? null,
    daily_usd: row?.dailyUsd ?? null,
    monthly_tokens: row?.monthlyTokens ?? null,
    daily_tokens: row?.dailyTokens ?? null,
    user_requests_per_minute: row?.userRequestsPerMinute ?? 60,
    updated_at: (row?.updatedAt ?? new Date(0)).toISOString(),
  };
}

export interface InstallLimitsInput {
  readonly monthly_usd?: number | null | undefined;
  readonly daily_usd?: number | null | undefined;
  readonly monthly_tokens?: number | null | undefined;
  readonly daily_tokens?: number | null | undefined;
  readonly user_requests_per_minute?: number | undefined;
}

const pick = <T>(next: T | undefined, before: T): T => (next === undefined ? before : next);

export async function setInstallLimits(
  db: KobeDb,
  input: InstallLimitsInput,
  actorId: string,
): Promise<InstallLimitsView> {
  return db.transaction(async (tx) => {
    const before = await getInstallLimits(tx);
    const next = {
      monthlyUsd: pick(input.monthly_usd, before.monthly_usd),
      dailyUsd: pick(input.daily_usd, before.daily_usd),
      monthlyTokens: pick(input.monthly_tokens, before.monthly_tokens),
      dailyTokens: pick(input.daily_tokens, before.daily_tokens),
      userRequestsPerMinute: pick(input.user_requests_per_minute, before.user_requests_per_minute),
    };
    await tx
      .update(installModelLimits)
      .set({ ...next, updatedBy: actorId, updatedAt: new Date() })
      .where(eq(installModelLimits.id, 1));
    if (next.userRequestsPerMinute !== before.user_requests_per_minute) await bumpModelsConfig(tx);
    await notifyModels(tx, `${MODELS_BUDGETS_PREFIX}*`);
    await recordAudit(tx, {
      action: "models.budget.changed",
      target: {
        scope: "install",
        monthlyUsd: next.monthlyUsd,
        dailyUsd: next.dailyUsd,
        monthlyVolume: next.monthlyTokens,
        dailyVolume: next.dailyTokens,
        requestsPerMinute: next.userRequestsPerMinute,
      },
    });
    return getInstallLimits(tx);
  });
}

/** Spend of the team (or one member) this month and today, from the daily counters. */
async function spendOf(
  tx: KobeTx,
  teamId: string,
  userId: string | undefined,
  starts: { month: string; day: string },
): Promise<SpendView> {
  const res = await tx.execute<Row>(sql`
    SELECT ${SPEND(starts)} FROM model_spend_daily
     WHERE team_id = ${teamId}::uuid AND day >= ${starts.month}::date
       ${userId === undefined ? sql`` : sql`AND user_id = ${userId}::uuid`}`);
  return spendView(res.rows[0]);
}

/** Dollars and tokens this month and today over a daily counter table. */
const SPEND = (starts: { month: string; day: string }) =>
  sql`COALESCE(sum(cost_usd) FILTER (WHERE day >= ${starts.month}::date), 0) AS month_usd,
      COALESCE(sum(cost_usd) FILTER (WHERE day = ${starts.day}::date), 0) AS day_usd,
      COALESCE(sum(tokens) FILTER (WHERE day >= ${starts.month}::date), 0) AS month_tokens,
      COALESCE(sum(tokens) FILTER (WHERE day = ${starts.day}::date), 0) AS day_tokens`;

const spendView = (r: Row | undefined): SpendView => ({
  month_usd: Number(r?.month_usd ?? 0),
  day_usd: Number(r?.day_usd ?? 0),
  month_tokens: Number(r?.month_tokens ?? 0),
  day_tokens: Number(r?.day_tokens ?? 0),
});

export async function teamBudgetsView(
  db: KobeDb,
  teamId: string,
  now = new Date(),
): Promise<TeamBudgetsView> {
  const starts = periodStarts(now);
  return withTeam(db, teamId, async (tx) => {
    const install = await getInstallLimits(tx);
    const installSpend = spendView(
      (
        await tx.execute<Row>(sql`
          SELECT ${SPEND(starts)} FROM install_model_spend_daily
           WHERE day >= ${starts.month}::date`)
      ).rows[0],
    );
    const rows = await tx
      .select({
        userId: teamBudgets.userId,
        monthlyUsd: teamBudgets.monthlyUsd,
        dailyUsd: teamBudgets.dailyUsd,
        monthlyTokens: teamBudgets.monthlyTokens,
        dailyTokens: teamBudgets.dailyTokens,
        memberMonthlyUsd: teamBudgets.memberMonthlyUsd,
        memberDailyUsd: teamBudgets.memberDailyUsd,
        memberMonthlyTokens: teamBudgets.memberMonthlyTokens,
        memberDailyTokens: teamBudgets.memberDailyTokens,
        rpm: teamBudgets.userRequestsPerMinute,
        name: users.name,
        email: users.email,
      })
      .from(teamBudgets)
      .leftJoin(users, eq(users.id, teamBudgets.userId))
      .where(eq(teamBudgets.teamId, teamId));
    const team = rows.find((r) => r.userId === null);
    const members: MemberBudgetView[] = [];
    for (const r of rows) {
      if (r.userId === null) continue;
      members.push({
        user_id: r.userId,
        name: r.name,
        email: r.email,
        monthly_usd: r.monthlyUsd,
        daily_usd: r.dailyUsd,
        monthly_tokens: r.monthlyTokens,
        daily_tokens: r.dailyTokens,
        spent: await spendOf(tx, teamId, r.userId, starts),
      });
    }
    const teamRpm = team?.rpm ?? null;
    return {
      period: starts,
      install: {
        user_requests_per_minute: install.user_requests_per_minute,
        percent_used: {
          month_usd: percentOf(installSpend.month_usd, install.monthly_usd),
          day_usd: percentOf(installSpend.day_usd, install.daily_usd),
          month_tokens: percentOf(installSpend.month_tokens, install.monthly_tokens),
          day_tokens: percentOf(installSpend.day_tokens, install.daily_tokens),
        },
      },
      team: {
        monthly_usd: team?.monthlyUsd ?? null,
        daily_usd: team?.dailyUsd ?? null,
        monthly_tokens: team?.monthlyTokens ?? null,
        daily_tokens: team?.dailyTokens ?? null,
        user_requests_per_minute: teamRpm,
        spent: await spendOf(tx, teamId, undefined, starts),
        member_default: {
          monthly_usd: team?.memberMonthlyUsd ?? null,
          daily_usd: team?.memberDailyUsd ?? null,
          monthly_tokens: team?.memberMonthlyTokens ?? null,
          daily_tokens: team?.memberDailyTokens ?? null,
        },
      },
      effective_requests_per_minute: Math.min(
        install.user_requests_per_minute,
        teamRpm ?? install.user_requests_per_minute,
      ),
      members: members.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    };
  });
}

export interface TeamBudgetInput {
  readonly monthly_usd?: number | null | undefined;
  readonly daily_usd?: number | null | undefined;
  readonly monthly_tokens?: number | null | undefined;
  readonly daily_tokens?: number | null | undefined;
  /** Null: use the install's rate. */
  readonly user_requests_per_minute?: number | null | undefined;
  /** Every member without a budget of their own (fields left out keep their value). */
  readonly member_default?:
    { readonly [K in keyof BudgetAmounts]?: BudgetAmounts[K] | undefined } | undefined;
}

async function currentRow(tx: KobeTx, teamId: string, userId: string | null) {
  const [row] = await tx
    .select()
    .from(teamBudgets)
    .where(
      and(
        eq(teamBudgets.teamId, teamId),
        userId === null ? isNull(teamBudgets.userId) : eq(teamBudgets.userId, userId),
      ),
    )
    .for("update");
  return row;
}

/** Sets the team's own budget and request rate (team admins). */
export async function setTeamBudget(
  db: KobeDb,
  teamId: string,
  input: TeamBudgetInput,
  actorId: string,
): Promise<void> {
  await withTeam(db, teamId, async (tx) => {
    const before = await currentRow(tx, teamId, null);
    const next = {
      monthlyUsd: pick(input.monthly_usd, before?.monthlyUsd ?? null),
      dailyUsd: pick(input.daily_usd, before?.dailyUsd ?? null),
      monthlyTokens: pick(input.monthly_tokens, before?.monthlyTokens ?? null),
      dailyTokens: pick(input.daily_tokens, before?.dailyTokens ?? null),
      memberMonthlyUsd: pick(input.member_default?.monthly_usd, before?.memberMonthlyUsd ?? null),
      memberDailyUsd: pick(input.member_default?.daily_usd, before?.memberDailyUsd ?? null),
      memberMonthlyTokens: pick(
        input.member_default?.monthly_tokens,
        before?.memberMonthlyTokens ?? null,
      ),
      memberDailyTokens: pick(
        input.member_default?.daily_tokens,
        before?.memberDailyTokens ?? null,
      ),
      userRequestsPerMinute: pick(
        input.user_requests_per_minute,
        before?.userRequestsPerMinute ?? null,
      ),
    };
    if (before) {
      await tx
        .update(teamBudgets)
        .set({ ...next, updatedBy: actorId, updatedAt: new Date() })
        .where(and(eq(teamBudgets.teamId, teamId), eq(teamBudgets.id, before.id)));
    } else {
      await tx.insert(teamBudgets).values({ teamId, ...next, updatedBy: actorId });
    }
    if (next.userRequestsPerMinute !== (before?.userRequestsPerMinute ?? null)) {
      await bumpModelsConfig(tx);
    }
    await notifyModels(tx, `${MODELS_BUDGETS_PREFIX}${teamId}`);
    await recordAudit(tx, {
      action: "models.budget.changed",
      teamId,
      target: {
        scope: "team",
        monthlyUsd: next.monthlyUsd,
        dailyUsd: next.dailyUsd,
        monthlyVolume: next.monthlyTokens,
        dailyVolume: next.dailyTokens,
        memberDefault: {
          monthlyUsd: next.memberMonthlyUsd,
          dailyUsd: next.memberDailyUsd,
          monthlyVolume: next.memberMonthlyTokens,
          dailyVolume: next.memberDailyTokens,
        },
        requestsPerMinute: next.userRequestsPerMinute,
      },
    });
  });
}

async function isMember(tx: KobeTx, teamId: string, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  return row !== undefined;
}

/** Sets (or, with both amounts null, removes) one member's budget in the team. */
export async function setMemberBudget(
  db: KobeDb,
  teamId: string,
  userId: string,
  input: BudgetAmounts | null,
  actorId: string,
): Promise<"ok" | "not_member" | "not_found"> {
  return withTeam(db, teamId, async (tx) => {
    const before = await currentRow(tx, teamId, userId);
    if (input === null) {
      if (!before) return "not_found";
      await tx
        .delete(teamBudgets)
        .where(and(eq(teamBudgets.teamId, teamId), eq(teamBudgets.id, before.id)));
    } else {
      if (!(await isMember(tx, teamId, userId))) return "not_member";
      const values = {
        monthlyUsd: input.monthly_usd,
        dailyUsd: input.daily_usd,
        monthlyTokens: input.monthly_tokens,
        dailyTokens: input.daily_tokens,
      };
      if (before) {
        await tx
          .update(teamBudgets)
          .set({ ...values, updatedBy: actorId, updatedAt: new Date() })
          .where(and(eq(teamBudgets.teamId, teamId), eq(teamBudgets.id, before.id)));
      } else {
        await tx.insert(teamBudgets).values({ teamId, userId, ...values, updatedBy: actorId });
      }
    }
    await notifyModels(tx, `${MODELS_BUDGETS_PREFIX}${teamId}`);
    await recordAudit(tx, {
      action: "models.budget.changed",
      teamId,
      target: {
        scope: "user",
        userId,
        monthlyUsd: input?.monthly_usd ?? null,
        dailyUsd: input?.daily_usd ?? null,
        monthlyVolume: input?.monthly_tokens ?? null,
        dailyVolume: input?.daily_tokens ?? null,
        ...(input === null ? { removed: true as const } : {}),
      },
    });
    return "ok";
  });
}

export type BudgetState = "ok" | "warning" | "exhausted";

export interface BudgetStatusLine {
  readonly scope: BudgetLine["scope"];
  readonly period: BudgetLine["period"];
  readonly unit: BudgetLine["unit"];
  /** In `unit`; null for the install budget (its spend is every team's together). */
  readonly limit: number | null;
  readonly spent: number | null;
  readonly percent: number;
  readonly state: BudgetState;
}

export const stateOf = (line: BudgetLine): BudgetState => {
  const pct = percentUsed(line);
  return pct >= 100 ? "exhausted" : pct >= 80 ? "warning" : "ok";
};

/**
 * What a member sees in the chat (D30 "warn the user"): every budget that applies to them, with
 * its state. Their own budget only: never another member's.
 */
export async function memberBudgetStatus(
  db: KobeDb,
  teamId: string,
  userId: string,
): Promise<{ readonly state: BudgetState; readonly lines: readonly BudgetStatusLine[] }> {
  const state = await withTeam(db, teamId, (tx) => loadMemberBudgetState(tx, teamId, userId));
  const lines = state.lines.map((l) => ({
    scope: l.scope,
    period: l.period,
    unit: l.unit,
    limit: l.scope === "install" ? null : l.limit,
    spent: l.scope === "install" ? null : Math.round(l.spent * 1e6) / 1e6,
    percent: Math.min(100, Math.round(percentUsed(l))),
    state: stateOf(l),
  }));
  const worst = lines.some((l) => l.state === "exhausted")
    ? "exhausted"
    : lines.some((l) => l.state === "warning")
      ? "warning"
      : "ok";
  return { state: worst, lines };
}
