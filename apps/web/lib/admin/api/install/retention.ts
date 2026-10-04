/** Install console: retention maximum (`/v1/install/retention`, install.retention.manage; KOBE-18). */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { RetentionPeriod } from "../team/retention";

export interface RetentionMaximum {
  readonly maximum: RetentionPeriod;
}

const BASE = "/v1/install/retention";

export function getRetentionMaximum(): Promise<ApiResult<RetentionMaximum>> {
  return apiRequest(BASE);
}

export function putRetentionMaximum(
  maximum: RetentionPeriod,
): Promise<ApiResult<RetentionMaximum>> {
  return apiRequest(BASE, { method: "PUT", json: { maximum } });
}
