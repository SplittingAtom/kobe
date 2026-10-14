/**
 * Usage dashboards and run usage (KOBE-43): `/v1/team/usage` (team.budgets.manage),
 * `/v1/site/usage` (site.usage.read), `/v1/runs/{id}/usage` (the run's readers).
 * Responses arrive camelized.
 */
import { apiRequest, type ApiResult } from "../../api/client";

const enc = encodeURIComponent;

export interface UsageTotals {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly unpricedCalls: number;
  readonly estimatedCalls: number;
}

export interface SeriesPoint extends UsageTotals {
  readonly t: string;
}

export interface UserUsage extends UsageTotals {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
}

export interface ModelUsage extends UsageTotals {
  readonly model: string;
}

export interface AgentUsage extends UsageTotals {
  readonly agentId: string | null;
  readonly slug: string | null;
  readonly scope: "team" | "personal" | "gallery" | null;
}

export interface TeamUsageSummary extends UsageTotals {
  readonly teamId: string;
  readonly slug: string;
  readonly name: string;
}

export interface UsageReport {
  readonly range: { readonly from: string; readonly to: string; readonly bucket: "hour" | "day" };
  readonly totals: UsageTotals;
  readonly series: readonly SeriesPoint[];
  readonly byUser: readonly UserUsage[];
  readonly byModel: readonly ModelUsage[];
  readonly byAgent: readonly AgentUsage[];
  /** Site report only. */
  readonly byTeam?: readonly TeamUsageSummary[];
}

export interface RunUsage extends UsageTotals {
  readonly runId: string;
  /** The run's prompt entry (KOBE-208); null before Pi committed it, absent on older servers. */
  readonly userEntryId?: string | null;
  readonly models: readonly string[];
}

/** The thread's newest model call that read input (KOBE-211: the context gauge). */
export interface LatestCall {
  readonly at: string;
  /** `<gateway provider>/<model>` as the call named it. */
  readonly model: string;
  /** Input tokens not read from a prompt cache. */
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
}

/** `GET /v1/threads/{id}/usage`: per run, in the order the runs first called a model. */
export interface ThreadUsage {
  readonly threadId: string;
  readonly runs: readonly RunUsage[];
  /** Null before the first call; absent on older servers. */
  readonly latestCall?: LatestCall | null;
}

export interface UsageQuery {
  readonly from: string;
  readonly to: string;
}

const query = (q: UsageQuery) => `?from=${enc(q.from)}&to=${enc(q.to)}`;

export function getTeamUsage(teamId: string, q: UsageQuery): Promise<ApiResult<UsageReport>> {
  return apiRequest<UsageReport>(`/v1/team/usage${query(q)}`, { teamId });
}

export function getSiteUsage(q: UsageQuery): Promise<ApiResult<UsageReport>> {
  return apiRequest<UsageReport>(`/v1/site/usage${query(q)}`);
}

export function getRunUsage(teamId: string, runId: string): Promise<ApiResult<RunUsage>> {
  return apiRequest<RunUsage>(`/v1/runs/${enc(runId)}/usage`, { teamId });
}
