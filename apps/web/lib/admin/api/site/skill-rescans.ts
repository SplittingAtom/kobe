/** Site console: skill rescans on scanner rule-set changes (`/v1/site/skill-rescans`; KOBE-313). */
import { apiRequest, type ApiResult } from "../../../api/client";

export interface RescanSuspension {
  readonly scope: "team" | "personal" | "catalog";
  readonly teamId?: string;
  readonly skillId: string;
  readonly version: number | string;
  readonly slug: string;
}

export interface SkillRescan {
  /** The rule set's ordinal. */
  readonly ruleSet: number;
  readonly ruleSetVersion: string;
  readonly status: "running" | "done" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly scanned: number;
  readonly changed: number;
  readonly suspended: number;
  readonly failed: number;
  readonly suspensions: readonly RescanSuspension[];
}

export interface SkillRescans {
  /** The rule set this server scans with. */
  readonly current: string;
  /** Newest first. */
  readonly rescans: readonly SkillRescan[];
}

export function listSkillRescans(): Promise<ApiResult<SkillRescans>> {
  return apiRequest("/v1/site/skill-rescans");
}
