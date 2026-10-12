/**
 * Budgets and rate limits (KOBE-42, D30): `/v1/team/budgets` (team.budgets.manage),
 * `/v1/team/budgets/status` (any member, the chat banner), `/v1/site/budget`
 * (site.budgets.manage). Responses arrive camelized; request bodies use the routes' snake_case.
 */
import { apiRequest, type ApiResult } from "../../api/client";

const enc = encodeURIComponent;

/** Dollar and token budgets (token budgets also cap models without prices). */
export interface BudgetAmounts {
  readonly monthlyUsd: number | null;
  readonly dailyUsd: number | null;
  readonly monthlyTokens: number | null;
  readonly dailyTokens: number | null;
}

export interface Spend {
  readonly monthUsd: number;
  readonly dayUsd: number;
  readonly monthTokens: number;
  readonly dayTokens: number;
}

/** Request body form of {@link BudgetAmounts}. */
export interface BudgetAmountsInput {
  readonly monthly_usd: number | null;
  readonly daily_usd: number | null;
  readonly monthly_tokens: number | null;
  readonly daily_tokens: number | null;
}

export interface SiteLimits extends BudgetAmounts {
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
  /** The site's spend is every team's together: shown in percent only. */
  readonly site: {
    readonly userRequestsPerMinute: number;
    readonly percentUsed: {
      readonly monthUsd: number | null;
      readonly dayUsd: number | null;
      readonly monthTokens: number | null;
      readonly dayTokens: number | null;
    };
  };
  readonly team: BudgetAmounts & {
    readonly userRequestsPerMinute: number | null;
    readonly spent: Spend;
    readonly memberDefault: BudgetAmounts;
  };
  readonly effectiveRequestsPerMinute: number;
  readonly members: readonly MemberBudget[];
}

export type BudgetState = "ok" | "warning" | "exhausted";

export interface BudgetStatusLine {
  readonly scope: "site" | "team" | "user";
  readonly period: "month" | "day";
  readonly unit: "usd" | "tokens";
  /** Null for the site budget. */
  readonly limit: number | null;
  readonly spent: number | null;
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
  input: Partial<BudgetAmountsInput> & {
    readonly user_requests_per_minute?: number | null;
    readonly member_default?: BudgetAmountsInput;
  },
): Promise<ApiResult<TeamBudgets>> {
  return apiRequest<TeamBudgets>("/v1/team/budgets/team", { method: "PUT", json: input, teamId });
}

export function setMemberBudget(
  teamId: string,
  userId: string,
  input: BudgetAmountsInput,
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

export function getSiteBudget(): Promise<ApiResult<SiteLimits>> {
  return apiRequest<SiteLimits>("/v1/site/budget");
}

export function setSiteBudget(
  input: BudgetAmountsInput & { readonly user_requests_per_minute: number },
): Promise<ApiResult<SiteLimits>> {
  return apiRequest<SiteLimits>("/v1/site/budget", { method: "PUT", json: input });
}

/** "12.5" → 12.5, "" → null, anything else → undefined (invalid). */
export function parseAmount(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const n = Number(t);
  return n <= 1_000_000_000 ? n : undefined;
}

/** "1,500,000" or "1500000" → 1500000, "" → null, anything else → undefined (invalid). */
export function parseTokens(text: string): number | null | undefined {
  const t = text.trim().replace(/[,_ ]/g, "");
  if (t === "") return null;
  if (!/^\d{1,16}$/.test(t)) return undefined;
  const n = Number(t);
  return n <= 1_000_000_000_000_000 ? n : undefined;
}
