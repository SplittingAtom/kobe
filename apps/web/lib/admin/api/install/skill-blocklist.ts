/** Install console: skill blocklist (`/v1/install/skill-blocklist`, install.blocklist.manage; KOBE-81). */
import { apiRequest, type ApiResult } from "../../../api/client";

const BASE = "/v1/install/skill-blocklist";

export interface BlockedSkill {
  readonly contentHash: string;
  readonly reason: string;
  readonly addedBy: string;
  readonly addedAt: string;
}

export interface BlockedSkillPage {
  readonly entries: readonly BlockedSkill[];
  /** Pass back to get the next page; null on the last. */
  readonly nextCursor: string | null;
}

/** 64 hexadecimal characters, either case (the server stores lowercase). */
export const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;
export const REASON_MAX = 500;

export function listBlockedSkills(cursor?: string): Promise<ApiResult<BlockedSkillPage>> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiRequest(`${BASE}${query}`);
}

export async function blockSkillHash(
  contentHash: string,
  reason: string,
): Promise<ApiResult<BlockedSkill>> {
  const res = await apiRequest<{ entry: BlockedSkill }>(BASE, {
    method: "POST",
    json: { contentHash, reason },
  });
  return res.ok ? { ...res, data: res.data.entry } : res;
}

export function unblockSkillHash(contentHash: string): Promise<ApiResult<void>> {
  return apiRequest(`${BASE}/${encodeURIComponent(contentHash)}`, { method: "DELETE" });
}
