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
export interface BudgetAmounts {
  readonly monthly_usd: number | null;
  readonly daily_usd: number | null;
}

export interface InstallLimitsView extends BudgetAmounts {
  readonly user_requests_per_minute: number;
  readonly updated_at: string;
}

export interface SpendView {
  readonly month_usd: number;
  readonly day_usd: number;
}

export interface MemberBudgetView extends BudgetAmounts {
  readonly user_id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly spent: SpendView;
}

export interface TeamBudgetsView {
  readonly period: { readonly month: string; readonly day: string };
  readonly install: InstallLimitsView & { readonly spent: SpendView };
  readonly team: BudgetAmounts & {
    readonly user_requests_per_minute: number | null;
    readonly spent: SpendView;
  };
  /** The per-user request rate members get (the install's, or the team's lower one). */
  readonly effective_requests_per_minute: number;
  readonly members: readonly MemberBudgetView[];
}

type Row = Record<string, unknown>;

export async function getInstallLimits(db: KobeDb | KobeTx): Promise<InstallLimitsView> {
  const [row] = await db.select().from(installModelLimits).where(eq(installModelLimits.id, 1));
  return {
    monthly_usd: row?.monthlyUsd ?? null,
    daily_usd: row?.dailyUsd ?? null,
    user_requests_per_minute: row?.userRequestsPerMinute ?? 60,
    updated_at: (row?.updatedAt ?? new Date(0)).toISOString(),
  };
}

export interface InstallLimitsInput {
  readonly monthly_usd?: number | null | undefined;
  readonly daily_usd?: number | null | undefined;
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
    SELECT COALESCE(sum(cost_usd) FILTER (WHERE day >= ${starts.month}::date), 0) AS month,
           COALESCE(sum(cost_usd) FILTER (WHERE day = ${starts.day}::date), 0) AS day
      FROM model_spend_daily
     WHERE team_id = ${teamId}::uuid AND day >= ${starts.month}::date
       ${userId === undefined ? sql`` : sql`AND user_id = ${userId}::uuid`}`);
  return { month_usd: Number(res.rows[0]?.month ?? 0), day_usd: Number(res.rows[0]?.day ?? 0) };
}

export async function teamBudgetsView(
  db: KobeDb,
  teamId: string,
  now = new Date(),
): Promise<TeamBudgetsView> {
  const starts = periodStarts(now);
  return withTeam(db, teamId, async (tx) => {
    const install = await getInstallLimits(tx);
    const installSpend = await tx.execute<Row>(sql`
      SELECT COALESCE(sum(cost_usd) FILTER (WHERE day >= ${starts.month}::date), 0) AS month,
             COALESCE(sum(cost_usd) FILTER (WHERE day = ${starts.day}::date), 0) AS day
        FROM install_model_spend_daily WHERE day >= ${starts.month}::date`);
    const rows = await tx
      .select({
        userId: teamBudgets.userId,
        monthlyUsd: teamBudgets.monthlyUsd,
        dailyUsd: teamBudgets.dailyUsd,
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
        spent: await spendOf(tx, teamId, r.userId, starts),
      });
    }
    const teamRpm = team?.rpm ?? null;
    return {
      period: starts,
      install: {
        ...install,
        spent: {
          month_usd: Number(installSpend.rows[0]?.month ?? 0),
          day_usd: Number(installSpend.rows[0]?.day ?? 0),
        },
      },
      team: {
        monthly_usd: team?.monthlyUsd ?? null,
        daily_usd: team?.dailyUsd ?? null,
        user_requests_per_minute: teamRpm,
        spent: await spendOf(tx, teamId, undefined, starts),
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
  /** Null: use the install's rate. */
  readonly user_requests_per_minute?: number | null | undefined;
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
      const values = { monthlyUsd: input.monthly_usd, dailyUsd: input.daily_usd };
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
  readonly limit_usd: number;
  readonly spent_usd: number;
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
    limit_usd: l.limitUsd,
    spent_usd: Math.round(l.spentUsd * 1e6) / 1e6,
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
