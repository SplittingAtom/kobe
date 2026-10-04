/**
 * Budgets and rate limits (KOBE-42, D30): `/v1/team/budgets` (team.budgets.manage),
 * `/v1/team/budgets/status` (any member, the chat banner), `/v1/install/budget`
 * (install.budgets.manage). Responses arrive camelized; request bodies use the routes' snake_case.
 */
import { apiRequest, type ApiResult } from "../../api/client";

const enc = encodeURIComponent;

export interface BudgetAmounts {
  readonly monthlyUsd: number | null;
  readonly dailyUsd: number | null;
}

export interface Spend {
  readonly monthUsd: number;
  readonly dayUsd: number;
}

export interface InstallLimits extends BudgetAmounts {
  readonly userRequestsPerMinute: number;
  readonly updatedAt: string;
}

export interface MemberBudget extends BudgetAmounts {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly spent: Spend;
}

export interface TeamBudgets {
  readonly period: { readonly month: string; readonly day: string };
  /** The install's spend is every team's together: shown in percent only. */
  readonly install: InstallLimits & {
    readonly percentUsed: { readonly month: number | null; readonly day: number | null };
  };
  readonly team: BudgetAmounts & {
    readonly userRequestsPerMinute: number | null;
    readonly spent: Spend;
  };
  readonly effectiveRequestsPerMinute: number;
  readonly members: readonly MemberBudget[];
}

export type BudgetState = "ok" | "warning" | "exhausted";

export interface BudgetStatusLine {
  readonly scope: "install" | "team" | "user";
  readonly period: "month" | "day";
  /** Null for the install budget. */
  readonly limitUsd: number | null;
  readonly spentUsd: number | null;
  readonly percent: number;
  readonly state: BudgetState;
}

export interface BudgetStatus {
  readonly state: BudgetState;
  readonly lines: readonly BudgetStatusLine[];
}

export function getTeamBudgets(teamId: string): Promise<ApiResult<TeamBudgets>> {
  return apiRequest<TeamBudgets>("/v1/team/budgets", { teamId });
}

export function setTeamBudget(
  teamId: string,
  input: {
    readonly monthly_usd: number | null;
    readonly daily_usd: number | null;
    readonly user_requests_per_minute: number | null;
  },
): Promise<ApiResult<TeamBudgets>> {
  return apiRequest<TeamBudgets>("/v1/team/budgets/team", { method: "PUT", json: input, teamId });
}

export function setMemberBudget(
  teamId: string,
  userId: string,
  input: { readonly monthly_usd: number | null; readonly daily_usd: number | null },
): Promise<ApiResult<TeamBudgets>> {
  return apiRequest<TeamBudgets>(`/v1/team/budgets/members/${enc(userId)}`, {
    method: "PUT",
    json: input,
    teamId,
  });
}

export function removeMemberBudget(
  teamId: string,
  userId: string,
): Promise<ApiResult<TeamBudgets>> {
  return apiRequest<TeamBudgets>(`/v1/team/budgets/members/${enc(userId)}`, {
    method: "DELETE",
    teamId,
  });
}

export function getBudgetStatus(teamId: string): Promise<ApiResult<BudgetStatus>> {
  return apiRequest<BudgetStatus>("/v1/team/budgets/status", { teamId });
}

export function getInstallBudget(): Promise<ApiResult<InstallLimits>> {
  return apiRequest<InstallLimits>("/v1/install/budget");
}

export function setInstallBudget(input: {
  readonly monthly_usd: number | null;
  readonly daily_usd: number | null;
  readonly user_requests_per_minute: number;
}): Promise<ApiResult<InstallLimits>> {
  return apiRequest<InstallLimits>("/v1/install/budget", { method: "PUT", json: input });
}

/** "12.5" → 12.5, "" → null, anything else → undefined (invalid). */
export function parseAmount(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const n = Number(t);
  return n <= 1_000_000_000 ? n : undefined;
}
