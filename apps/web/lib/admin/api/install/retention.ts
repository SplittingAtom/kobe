/** Install console: retention maximum (`/v1/install/retention`, install.retention.manage; KOBE-18). */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { RetentionPeriod } from "../team/retention";

export interface RetentionMaximum {
  /** As chosen (in force, or pending). */
  readonly maximum: RetentionPeriod;
  /** In force now. */
  readonly applied: RetentionPeriod;
  /** A lowering waiting out its 7-day grace period. */
  readonly pending: { readonly maximum: RetentionPeriod; readonly effectiveAt: string } | null;
}

/** What GET returns: the maximum plus whether the deleting jobs are paused (KOBE-243). */
export interface RetentionStatus extends RetentionMaximum {
  /** KOBE_RETENTION_PAUSED: the nightly pass, offboarding purges and workspace GC do nothing. */
  readonly paused: boolean;
}

const BASE = "/v1/install/retention";

export function getRetentionMaximum(): Promise<ApiResult<RetentionStatus>> {
  return apiRequest(BASE);
}

export function putRetentionMaximum(
  maximum: RetentionPeriod,
): Promise<ApiResult<RetentionMaximum>> {
  return apiRequest(BASE, { method: "PUT", json: { maximum } });
}

export function cancelRetentionMaximumChange(): Promise<ApiResult<RetentionMaximum>> {
  return apiRequest(`${BASE}/pending`, { method: "DELETE" });
}
