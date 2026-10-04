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

/** A shortening waiting out its 7-day grace period (user decision 2026-10-04). */
export interface PendingRetention {
  readonly period: RetentionPeriod;
  /** ISO time it applies. */
  readonly effectiveAt: string;
}

export interface TeamRetention {
  /** What the team admins chose (in force, or pending). */
  readonly period: RetentionPeriod;
  /** The install maximum as chosen. */
  readonly maximum: RetentionPeriod;
  /** What the nightly job applies now. */
  readonly effective: RetentionPeriod;
  /** The team's own pending shortening (team admins can cancel it). */
  readonly pending: PendingRetention | null;
  /** The next shortening of what applies, from the team or the install (the banner). */
  readonly upcoming: PendingRetention | null;
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

/** Cancels the team's pending shortening during its grace period. */
export function cancelTeamRetentionChange(teamId: string): Promise<ApiResult<TeamRetention>> {
  return apiRequest(`${BASE}/pending`, { method: "DELETE", teamId });
}

/** "30 days", "1 year", … in running text. */
export function periodText(period: RetentionPeriod): string {
  return PERIOD_LABELS[period].toLowerCase();
}
