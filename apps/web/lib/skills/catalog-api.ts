/**
 * The Catalog tab (KOBE-336, SK25): browse and search the Site catalog from the active team, a
 * skill's detail with this team's egress check, and Request access for a host (D28). Responses
 * arrive camelized.
 */
import { apiRequest, type ApiResult } from "../api/client";

export const CATALOG_SORTS = ["name", "updated", "teams"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export interface CatalogCard {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly publisher: string;
  readonly status: string;
  readonly topics: readonly string[];
  readonly latest: {
    readonly versionId: string;
    readonly semver: string;
    readonly verdict: string;
    readonly approvedAt: string | null;
  };
  readonly score: {
    readonly passRate: number | null;
    readonly lift: number | null;
    readonly cases: number | null;
  } | null;
  readonly teamsInstalled: number | "few";
  /** Members using it and the thumbs-up share (0–1) in the window, or "few" (KOBE-339). */
  readonly usage?: { readonly members: number | "few"; readonly thumbsUp: number | "few" };
  readonly state: {
    readonly installed: {
      readonly semver: string | null;
      readonly pinMode: string;
      readonly access: string;
    } | null;
    readonly addedByMe: boolean;
    /** The caller's own Add for me here (KOBE-338). */
    readonly myAdd?: { readonly semver: string; readonly pinMode: string } | null;
    readonly blocked: boolean;
  };
}

export interface CatalogPage {
  readonly skills: readonly CatalogCard[];
  readonly tags: readonly string[];
  /** The team switch "Members may add catalog skills for themselves" (KOBE-338). */
  readonly membersMayAdd?: boolean;
  readonly usageWindow?: UsageWindow;
}

export interface CatalogDetail extends CatalogCard {
  readonly skillMd: string | null;
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly versions: readonly {
    readonly id: string;
    readonly semver: string;
    readonly state: string;
    readonly approvedAt: string | null;
    readonly changelog: string | null;
    readonly verdict: string;
  }[];
  readonly authoritativeScorecard: Record<string, unknown> | null;
  readonly license: string | null;
  readonly egress: readonly {
    readonly host: string;
    readonly enabledHere: boolean;
    readonly inCeiling: boolean;
  }[];
  readonly packages: Record<string, unknown>;
  readonly maintainers: readonly string[];
  readonly agents: readonly { readonly id: string; readonly name: string }[];
  /** The caller may ask the Team admins for a host (D28). */
  readonly canRequestEgress: boolean;
  /** The team switch "Members may add catalog skills for themselves" (KOBE-338). */
  readonly membersMayAdd?: boolean;
  /** The caller may block the skill in this team (Team admins). */
  readonly canBlock?: boolean;
  readonly usageWindow?: UsageWindow;
  /** A deprecated skill's replacement (KOBE-340). */
  readonly replacement?: { readonly id: string; readonly name: string } | null;
  /** The caller may deprecate it (a maintainer or Site admin). */
  readonly canDeprecate?: boolean;
}

export interface CatalogFilter {
  readonly q: string;
  readonly tag: string | null;
  readonly sort: CatalogSort;
}

export function catalogQuery(f: CatalogFilter): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.tag) p.set("tag", f.tag);
  if (f.sort !== "name") p.set("sort", f.sort);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function listCatalog(teamId: string, f: CatalogFilter): Promise<ApiResult<CatalogPage>> {
  return apiRequest(`/v1/skills/catalog${catalogQuery(f)}`, { teamId });
}

export function getCatalogSkill(teamId: string, id: string): Promise<ApiResult<CatalogDetail>> {
  return apiRequest(`/v1/skills/catalog/${encodeURIComponent(id)}`, { teamId });
}

/** Asks this team's admins to enable `domain` (D28): the same request as the chat's notice. */
export function requestEgress(teamId: string, domain: string): Promise<ApiResult<unknown>> {
  return apiRequest("/v1/egress/requests", { method: "POST", json: { domain }, teamId });
}

export type PinMode = "pinned" | "within_major" | "latest";

/** Add for me (KOBE-338, SK25): the skill loads only in the caller's runs in this team. */
export function addForMe(
  teamId: string,
  skillId: string,
  body: { readonly version: string; readonly pinMode: PinMode },
): Promise<ApiResult<{ semver: string; pinMode: PinMode; runs: string | null }>> {
  return apiRequest(`/v1/me/skills/adds/${encodeURIComponent(skillId)}`, {
    method: "PUT",
    json: body,
    teamId,
  });
}

export function removeMyAdd(teamId: string, skillId: string): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/me/skills/adds/${encodeURIComponent(skillId)}`, {
    method: "DELETE",
    teamId,
  });
}

/** Request for team: asks this team's admins to install the skill. */
export function requestForTeam(
  teamId: string,
  skillId: string,
): Promise<ApiResult<{ requested: boolean; alreadyRequested: boolean }>> {
  return apiRequest(`/v1/skills/catalog/${encodeURIComponent(skillId)}/request`, {
    method: "POST",
    json: {},
    teamId,
  });
}

/** A Team admin's block of the skill in this team (removes members' adds, refuses new ones). */
export function blockInTeam(
  teamId: string,
  skillId: string,
): Promise<ApiResult<{ blocked: boolean; changed: boolean; addsRemoved: number }>> {
  return apiRequest(`/v1/team/skills/blocks/${encodeURIComponent(skillId)}`, {
    method: "PUT",
    json: {},
    teamId,
  });
}

export function unblockInTeam(teamId: string, skillId: string): Promise<ApiResult<unknown>> {
  return apiRequest(`/v1/team/skills/blocks/${encodeURIComponent(skillId)}`, {
    method: "DELETE",
    teamId,
  });
}

/** The fixed window usage covers: the last 30 finished UTC days (KOBE-339). */
export interface UsageWindow {
  readonly from: string;
  readonly to: string;
}

export type Shown = number | "few";

/** Site-wide usage of one skill, for its maintainers and Site admins (KOBE-339, SK26). */
export interface SiteSkillUsage {
  readonly totals: {
    readonly teamsInstalled: Shown;
    readonly members: Shown;
    readonly runs: Shown;
    readonly thumbsUp: Shown;
    readonly optOuts: Shown;
  };
  readonly versions: readonly string[];
  /** A column is null when it is withheld (a hidden cell could be read from it). */
  readonly perVersion: {
    readonly teamsRunning: readonly Shown[] | null;
    readonly members: readonly Shown[] | null;
    readonly runs: readonly Shown[] | null;
    readonly thumbsUp: readonly Shown[] | null;
  };
  readonly window: UsageWindow;
  readonly refreshedAt: string;
}

export function getSkillUsage(skillId: string): Promise<ApiResult<SiteSkillUsage>> {
  return apiRequest(`/v1/skills/catalog/${encodeURIComponent(skillId)}/usage`);
}

/** "From to To" as UTC days; the window's end is exclusive, so the last day is the one before. */
export function windowLabel(w: UsageWindow): string {
  const last = new Date(new Date(w.to).getTime() - 86_400_000);
  return `${w.from.slice(0, 10)} to ${last.toISOString().slice(0, 10)} (UTC)`;
}

export const shownCount = (v: Shown, noun: string, plural = `${noun}s`): string =>
  v === "few" ? `Few ${plural}` : `${v} ${v === 1 ? noun : plural}`;

export const shownShare = (v: Shown): string =>
  v === "few" ? "Few ratings" : `${Math.round(v * 100)}% thumbs up`;
