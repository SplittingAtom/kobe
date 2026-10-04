/** Team console: retention period (`/v1/team/retention`; read: members, change: team admins; KOBE-18). */
import { apiRequest, type ApiResult } from "../../../api/client";

/** The D18 periods, shortest first. */
export const RETENTION_PERIODS = ["30d", "90d", "1y", "forever"] as const;
export type RetentionPeriod = (typeof RETENTION_PERIODS)[number];

export const PERIOD_LABELS: Readonly<Record<RetentionPeriod, string>> = {
  "30d": "30 days",
  "90d": "90 days",
  "1y": "1 year",
  forever: "Forever",
};

export interface TeamRetention {
  /** What the team admins chose. */
  readonly period: RetentionPeriod;
  /** The install maximum. */
  readonly maximum: RetentionPeriod;
  /** What the nightly job applies: the shorter of the two. */
  readonly effective: RetentionPeriod;
  /** Periods the team may choose under the maximum. */
  readonly allowed: readonly RetentionPeriod[];
}

const BASE = "/v1/team/retention";

export function getTeamRetention(teamId: string): Promise<ApiResult<TeamRetention>> {
  return apiRequest(BASE, { teamId });
}

export function putTeamRetention(
  teamId: string,
  period: RetentionPeriod,
): Promise<ApiResult<TeamRetention>> {
  return apiRequest(BASE, { method: "PUT", json: { period }, teamId });
}
