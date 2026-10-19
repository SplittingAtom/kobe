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
  readonly state: {
    readonly installed: {
      readonly semver: string | null;
      readonly pinMode: string;
      readonly access: string;
    } | null;
    readonly addedByMe: boolean;
    readonly blocked: boolean;
  };
}

export interface CatalogPage {
  readonly skills: readonly CatalogCard[];
  readonly tags: readonly string[];
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
