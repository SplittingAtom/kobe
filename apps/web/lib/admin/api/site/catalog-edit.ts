/**
 * Site console: view and edit catalog skills (`/v1/site/skills/catalog-skills/:skillId`,
 * site.skills.catalog.manage; KOBE-495). The site draft is one per skill, changed under
 * `If-Match: <rev>` like a Workbench draft; Save version publishes it as publisher `site`.
 */
import { apiRequest, apiTextFile, type ApiResult } from "../../../api/client";
import type { VersionDiff } from "./skill-review";

export const CATALOG_SKILLS_PATH = "/v1/site/skills/catalog-skills";
const enc = encodeURIComponent;
const base = (skillId: string) => `${CATALOG_SKILLS_PATH}/${enc(skillId)}`;
/** A path as URL segments, each encoded on its own. */
const filePath = (path: string) => path.split("/").map(enc).join("/");
const etag = (rev: number) => `"${rev}"`;

export type CatalogPublisher = "kobe" | "maintainer" | "site";

export interface CatalogVersionRow {
  readonly id: string;
  readonly semver: string;
  readonly seq: number;
  readonly publisher: CatalogPublisher;
  readonly state: string;
  readonly verdict: "pass" | "caution" | "block";
  readonly approvedAt: string | null;
  readonly submittedAt: string;
  readonly submittedBy: string | null;
  readonly runtimeHash: string;
  readonly packageHash: string;
  readonly changelog: string | null;
  readonly stored: boolean;
}

export interface KobeState {
  readonly detached: boolean;
  readonly detachedAt: string | null;
  readonly detachedBy: string | null;
  readonly detachedFromVersion: string | null;
  readonly shippedVersion: string | null;
  readonly updateAvailable: boolean;
}

export interface SiteDraftInfo {
  readonly baseVersionId: string;
  readonly baseSemver: string;
  readonly rev: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface CatalogSkillView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly publisher: "kobe" | "maintainer";
  readonly status: string;
  readonly retired: boolean;
  readonly blocklisted: boolean;
  readonly kobe: KobeState | null;
  readonly draft: SiteDraftInfo | null;
  readonly versions: readonly CatalogVersionRow[];
}

export interface VersionFileInfo {
  readonly path: string;
  readonly size: number;
  readonly kind: "text" | "binary";
}

export interface CatalogVersionView {
  readonly version: CatalogVersionRow;
  readonly files: readonly VersionFileInfo[];
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  readonly frontmatterProblem: string | null;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly scan: Readonly<Record<string, unknown>>;
  readonly hashes: { readonly runtime: string; readonly package: string };
}

export interface RawVersionFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly encoding: "text" | "escaped" | "hex";
  readonly text: string;
  readonly truncated: boolean;
}

export interface SiteDraft {
  readonly id: string;
  readonly skillId: string;
  readonly baseVersionId: string;
  readonly rev: number;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface SiteDraftFile {
  readonly path: string;
  readonly size: number;
  readonly kind: "text" | "binary";
  readonly updatedAt: string;
}

export interface SiteDraftWithFiles {
  readonly draft: SiteDraft;
  readonly files: readonly SiteDraftFile[];
}

export interface SiteDraftChanged {
  readonly rev: number;
  readonly draft: SiteDraft;
}

export interface SitePublished {
  readonly versionId: string;
  readonly skillId: string;
  readonly name: string;
  readonly semver: string;
  readonly verdict: "pass" | "caution";
  readonly previous: { readonly publisher: string; readonly semver: string } | null;
}

export interface KobeCompare {
  readonly current: { readonly id: string; readonly semver: string; readonly publisher: string };
  readonly shipped: { readonly semver: string };
  readonly diff: Omit<VersionDiff, "against">;
}

export function getCatalogSkill(skillId: string): Promise<ApiResult<CatalogSkillView>> {
  return apiRequest(base(skillId));
}

export function getCatalogVersion(
  skillId: string,
  versionId: string,
): Promise<ApiResult<CatalogVersionView>> {
  return apiRequest(`${base(skillId)}/versions/${enc(versionId)}`);
}

export function getCatalogVersionFile(
  skillId: string,
  versionId: string,
  path: string,
): Promise<ApiResult<RawVersionFile>> {
  return apiRequest(`${base(skillId)}/versions/${enc(versionId)}/files/${filePath(path)}`);
}

export function startSiteDraft(
  skillId: string,
  versionId: string,
  replace = false,
): Promise<ApiResult<SiteDraftWithFiles>> {
  return apiRequest(`${base(skillId)}/draft`, {
    method: "POST",
    json: replace ? { versionId, replace } : { versionId },
  });
}

export function getSiteDraft(skillId: string): Promise<ApiResult<SiteDraftWithFiles>> {
  return apiRequest(`${base(skillId)}/draft`);
}

export function discardSiteDraft(skillId: string): Promise<ApiResult<unknown>> {
  return apiRequest(`${base(skillId)}/draft`, { method: "DELETE" });
}

export async function readSiteDraftText(skillId: string, path: string): Promise<ApiResult<string>> {
  const res = await apiTextFile(`${base(skillId)}/draft/files/${filePath(path)}`, {});
  return res.ok ? { ...res, data: res.data.text } : res;
}

export function putSiteDraftFile(
  skillId: string,
  path: string,
  rev: number,
  text: string,
): Promise<ApiResult<SiteDraftChanged>> {
  return apiRequest(`${base(skillId)}/draft/files/${filePath(path)}`, {
    method: "PUT",
    raw: { body: text, contentType: "text/plain; charset=utf-8" },
    ifMatch: etag(rev),
  });
}

export function deleteSiteDraftFile(
  skillId: string,
  path: string,
  rev: number,
): Promise<ApiResult<SiteDraftChanged>> {
  return apiRequest(`${base(skillId)}/draft/files/${filePath(path)}`, {
    method: "DELETE",
    ifMatch: etag(rev),
  });
}

export function scanSiteDraft<T>(skillId: string, signal?: AbortSignal): Promise<ApiResult<T>> {
  return apiRequest(`${base(skillId)}/draft/scan`, { signal });
}

export function suggestSiteBump<T>(skillId: string): Promise<ApiResult<T>> {
  return apiRequest(`${base(skillId)}/draft/bump`);
}

export function publishSiteDraft(
  skillId: string,
  rev: number,
  body: { readonly semver: string; readonly changelog: string },
): Promise<ApiResult<{ version: SitePublished; notified: number }>> {
  return apiRequest(`${base(skillId)}/draft/publish`, {
    method: "POST",
    json: body,
    ifMatch: etag(rev),
  });
}

export function compareWithKobe(skillId: string): Promise<ApiResult<KobeCompare>> {
  return apiRequest(`${base(skillId)}/kobe/compare`);
}

export function resetToKobe(
  skillId: string,
): Promise<ApiResult<{ shippedSemver: string; seed: { action: string } | null }>> {
  return apiRequest(`${base(skillId)}/kobe/reset`, { method: "POST", json: {} });
}
