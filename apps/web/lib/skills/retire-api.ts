/**
 * Retiring catalog versions (KOBE-340, SK31): maintainers and Site admins deprecate, Site admins
 * withdraw, revoke and unrevoke. Responses arrive camelized.
 */
import { apiRequest, type ApiResult } from "../api/client";

export type RetireAct = "deprecate" | "undeprecate" | "withdraw" | "revoke" | "unrevoke";

export interface RetirableVersions {
  readonly status: string;
  /** Site admins: withdraw, revoke, unrevoke. Maintainers deprecate only. */
  readonly mayRetire: boolean;
  readonly versions: readonly {
    readonly semver: string;
    readonly state: string;
    readonly suspended: boolean;
  }[];
}

export interface Retired {
  readonly state: string;
  /** Whether the notices went out (never how many: SK26). */
  readonly notified: boolean;
}

const base = (skillId: string) => `/v1/site/skills/catalog/${encodeURIComponent(skillId)}`;

export function listRetirable(skillId: string): Promise<ApiResult<RetirableVersions>> {
  return apiRequest(`${base(skillId)}/versions`);
}

export function retireVersion(
  skillId: string,
  semver: string,
  act: RetireAct,
  note: string,
): Promise<ApiResult<Retired>> {
  return apiRequest(`${base(skillId)}/versions/${encodeURIComponent(semver)}/${act}`, {
    method: "POST",
    json: note.trim() ? { note: note.trim() } : {},
  });
}

export function deprecateSkill(
  skillId: string,
  replacementId: string | null,
): Promise<ApiResult<Retired>> {
  return apiRequest(`${base(skillId)}/deprecate`, {
    method: "POST",
    json: replacementId ? { replacementId } : {},
  });
}

/** Which acts a version's state allows (SK31), for an actor who may retire or only deprecate. */
export function actsFor(state: string, mayRetire: boolean): RetireAct[] {
  const all: Record<string, RetireAct[]> = {
    approved: ["deprecate", "withdraw", "revoke"],
    deprecated: ["undeprecate", "withdraw", "revoke"],
    withdrawn: ["revoke"],
    revoked: ["unrevoke"],
  };
  return (all[state] ?? []).filter((a) => mayRetire || a === "deprecate" || a === "undeprecate");
}

/** Undoes a skill's deprecation (maintainers and Site admins). */
export function undeprecateSkill(skillId: string): Promise<ApiResult<Retired>> {
  return apiRequest(`${base(skillId)}/undeprecate`, { method: "POST", json: {} });
}
