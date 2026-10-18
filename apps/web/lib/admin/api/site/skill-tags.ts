/**
 * Site console: catalog tags and the Default tag (`/v1/site/skills`, site.skills.catalog.manage;
 * KOBE-314, SK5–SK8).
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const BASE = "/v1/site/skills";
const enc = encodeURIComponent;

export interface CatalogTag {
  readonly id: string;
  readonly name: string;
  readonly kind: "system" | "topic";
  readonly status: "active" | "retired";
}

export interface SiteCatalogSkill {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly publisher: string;
  readonly status: string;
  /** The newest approved version, if any. */
  readonly latest: string | null;
  readonly system: readonly string[];
  readonly topic: readonly string[];
  /** Default skills: the major Default installs follow. */
  readonly defaultMajor: number | null;
  /** Default skills: teams that opted out ("few" below the minimum count). */
  readonly optOuts: number | "few" | null;
}

/** A job's counts by outcome. */
export interface DefaultSyncCounts {
  readonly installed: number;
  readonly kept: number;
  readonly optedOut: number;
  readonly blocked: number;
  /** Teams skipped because they have their own skill of the same name. */
  readonly nameConflicts: number;
  readonly converted: number;
  readonly optoutsCleared: number;
  readonly moved: number;
}

export interface DefaultSync {
  readonly id: string;
  readonly skillId: string;
  readonly name: string;
  readonly kind: "add" | "remove" | "move_major";
  readonly major: number | null;
  readonly status: "queued" | "running" | "done" | "failed";
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly teamsTotal: number;
  readonly teamsDone: number;
  /**
   * Null while the job runs, and when fewer than 3 teams opted out, cleared, blocked or had a
   * name conflict (the minimum-count rule).
   */
  readonly counts: DefaultSyncCounts | null;
  readonly attempts: number;
  /** The last failure's code (e.g. `no_version`), if any. */
  readonly lastError: string | null;
  readonly nextAttemptAt: string | null;
}

/** Mirrors REGISTRY_TAG_PATTERN in @kobe/protocol. */
export const TAG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

export async function listCatalogTags(): Promise<ApiResult<readonly CatalogTag[]>> {
  const res = await apiRequest<{ tags: CatalogTag[] }>(`${BASE}/tags`);
  return res.ok ? { ...res, data: res.data.tags } : res;
}

export function createTopicTag(name: string): Promise<ApiResult<{ tag: CatalogTag }>> {
  return apiRequest(`${BASE}/tags`, { method: "POST", json: { name } });
}

export function updateTopicTag(
  id: string,
  change: { readonly name?: string; readonly status?: "active" | "retired" },
): Promise<ApiResult<{ tag: CatalogTag }>> {
  return apiRequest(`${BASE}/tags/${enc(id)}`, { method: "PATCH", json: change });
}

export async function listSiteCatalog(): Promise<ApiResult<readonly SiteCatalogSkill[]>> {
  const res = await apiRequest<{ skills: SiteCatalogSkill[] }>(`${BASE}/catalog`);
  return res.ok ? { ...res, data: res.data.skills } : res;
}

export function putSkillTags(
  skillId: string,
  tags: { readonly system: readonly "default"[]; readonly topic: readonly string[] },
): Promise<ApiResult<{ system: string[]; topic: string[]; syncId: string | null }>> {
  return apiRequest(`${BASE}/catalog/${enc(skillId)}/tags`, { method: "PUT", json: tags });
}

export function moveDefaultMajor(
  skillId: string,
  to: number,
): Promise<ApiResult<{ syncId: string; semver: string }>> {
  return apiRequest(`${BASE}/catalog/${enc(skillId)}/default/move-major`, {
    method: "POST",
    json: { to },
  });
}

export async function listDefaultSyncs(): Promise<ApiResult<readonly DefaultSync[]>> {
  const res = await apiRequest<{ syncs: DefaultSync[] }>(`${BASE}/default-syncs`);
  return res.ok ? { ...res, data: res.data.syncs } : res;
}
