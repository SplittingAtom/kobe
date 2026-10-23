import { unzipSync } from "fflate";
import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import type { BlobStore } from "../../retention/blobs.js";
import { blockedAmong } from "../blocklist.js";
import { compareSemver } from "../semver.js";
import { parseSkillMd } from "../skill-md.js";
import { rawFile, readPackage, type RawFile, type StoredPackage } from "../registry/review-diff.js";

/**
 * The Site Console's view of one catalog skill (KOBE-495): every version (published or not), and
 * for one version its files, SKILL.md frontmatter, manifest, provenance, scan and hashes. The
 * bytes are read from the catalog store and verified against the version row's hashes (as the
 * review screen and the catalog detail do); nothing beyond the package the catalog already serves.
 */

export interface SiteVersionRow {
  readonly id: string;
  readonly semver: string;
  readonly seq: number;
  readonly publisher: "kobe" | "maintainer" | "site";
  /** The review state, or `suspended` while a rescan's Block holds it. */
  readonly state: string;
  readonly verdict: "pass" | "caution" | "block";
  readonly approvedAt: string | null;
  readonly submittedAt: string;
  /** Who submitted it (a maintainer) or published it (a Site admin); null for Kobe's. */
  readonly submittedBy: string | null;
  readonly runtimeHash: string;
  readonly packageHash: string;
  readonly changelog: string | null;
  /** Its bytes are in the store (versions submitted before KOBE-333 may lack them). */
  readonly stored: boolean;
}

export interface KobeState {
  readonly detached: boolean;
  readonly detachedAt: string | null;
  readonly detachedBy: string | null;
  readonly detachedFromVersion: string | null;
  /** The newest shipped version the seed recorded while the skill was detached. */
  readonly shippedVersion: string | null;
  /** Detached, and Kobe ships a version above the one it was detached from. */
  readonly updateAvailable: boolean;
}

export interface SiteDraftInfo {
  readonly baseVersionId: string;
  readonly baseSemver: string;
  readonly rev: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface SiteSkillView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly publisher: "kobe" | "maintainer";
  readonly status: string;
  /** Deprecated or archived: Restore first (KOBE-495). */
  readonly retired: boolean;
  /** The newest version's bytes are on the Site's blocklist. */
  readonly blocklisted: boolean;
  readonly kobe: KobeState | null;
  readonly draft: SiteDraftInfo | null;
  readonly versions: readonly SiteVersionRow[];
}

export const RETIRED_STATUSES: readonly string[] = ["deprecated", "archived"];

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

/** Every version of the skill, newest first. */
export async function versionRows(db: KobeDb | KobeTx, skillId: string): Promise<SiteVersionRow[]> {
  const { rows } = await db.execute<{
    id: string;
    semver: string;
    seq: number;
    publisher: SiteVersionRow["publisher"];
    state: string;
    verdict: SiteVersionRow["verdict"];
    approved_at: Date | null;
    submitted_at: Date;
    submitter: string | null;
    runtime_hash: string;
    package_hash: string;
    manifest: Record<string, unknown>;
    stored: boolean;
  }>(sql`
    SELECT v.id, v.semver, v.seq, v.publisher::text AS publisher,
      CASE WHEN v.suspended_at IS NOT NULL THEN 'suspended' ELSE v.state::text END AS state,
      v.verdict::text AS verdict, v.approved_at, v.submitted_at, u.name AS submitter,
      v.runtime_hash, v.package_hash, v.manifest, v.runtime_storage_key IS NOT NULL AS stored
      FROM registry_versions v LEFT JOIN users u ON u.id = v.submitted_by
     WHERE v.skill_id = ${skillId}
     ORDER BY v.seq DESC`);
  return rows.map((r) => ({
    id: r.id,
    semver: r.semver,
    seq: Number(r.seq),
    publisher: r.publisher,
    state: r.state,
    verdict: r.verdict,
    approvedAt: iso(r.approved_at),
    submittedAt: iso(r.submitted_at) ?? "",
    submittedBy: r.submitter,
    runtimeHash: r.runtime_hash,
    packageHash: r.package_hash,
    changelog: typeof r.manifest.changelog === "string" ? r.manifest.changelog : null,
    stored: r.stored,
  }));
}

/** The highest semver among `versions` (any state: numbers are never reused). */
export function newestSemver(versions: readonly { readonly semver: string }[]): string | null {
  return versions.reduce<string | null>(
    (best, v) => (best === null || compareSemver(v.semver, best) > 0 ? v.semver : best),
    null,
  );
}

type SkillRow = {
  id: string;
  name: string;
  summary: string;
  publisher: "kobe" | "maintainer";
  status: string;
  detached_at: Date | null;
  detached_by: string | null;
  detached_from_version: string | null;
  kobe_shipped_version: string | null;
};

export function kobeState(r: SkillRow): KobeState | null {
  if (r.publisher !== "kobe") return null;
  const from = r.detached_from_version;
  const shipped = r.kobe_shipped_version;
  return {
    detached: r.detached_at !== null,
    detachedAt: iso(r.detached_at),
    detachedBy: r.detached_by,
    detachedFromVersion: from,
    shippedVersion: shipped,
    updateAvailable:
      r.detached_at !== null &&
      from !== null &&
      shipped !== null &&
      compareSemver(shipped, from) > 0,
  };
}

export async function skillRow(db: KobeDb | KobeTx, skillId: string): Promise<SkillRow | null> {
  const { rows } = await db.execute<SkillRow>(sql`
    SELECT s.id, s.name, s.summary, s.publisher::text AS publisher, s.status::text AS status,
      s.detached_at, u.name AS detached_by, s.detached_from_version, s.kobe_shipped_version
      FROM registry_skills s LEFT JOIN users u ON u.id = s.detached_by
     WHERE s.id = ${skillId}`);
  return rows[0] ?? null;
}

async function draftInfo(db: KobeDb, skillId: string): Promise<SiteDraftInfo | null> {
  const { rows } = await db.execute<{
    base_version_id: string;
    semver: string;
    rev: number;
    updated_at: Date;
    updated_by: string;
  }>(sql`
    SELECT d.base_version_id, v.semver, d.rev, d.updated_at, u.name AS updated_by
      FROM site_skill_drafts d
      JOIN registry_versions v ON v.id = d.base_version_id
      JOIN users u ON u.id = d.updated_by
     WHERE d.skill_id = ${skillId}`);
  const r = rows[0];
  if (!r) return null;
  return {
    baseVersionId: r.base_version_id,
    baseSemver: r.semver,
    rev: Number(r.rev),
    updatedAt: iso(r.updated_at) ?? "",
    updatedBy: r.updated_by,
  };
}

/** Whether any of the skill's versions has bytes on the blocklist. */
export async function skillBlocklisted(db: KobeDb, skillId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ runtime_hash: string; package_hash: string }>(sql`
      SELECT runtime_hash, package_hash FROM registry_versions WHERE skill_id = ${skillId}`);
    const hashes = [...new Set(rows.flatMap((r) => [r.runtime_hash, r.package_hash]))];
    return (await blockedAmong(tx, hashes)).length > 0;
  });
}

export async function siteSkillView(db: KobeDb, skillId: string): Promise<SiteSkillView | null> {
  const row = await skillRow(db, skillId);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    publisher: row.publisher,
    status: row.status,
    retired: RETIRED_STATUSES.includes(row.status),
    blocklisted: await skillBlocklisted(db, skillId),
    kobe: kobeState(row),
    draft: await draftInfo(db, skillId),
    versions: await versionRows(db, skillId),
  };
}

// --- One version -----------------------------------------------------------------------------

export interface VersionFile {
  readonly path: string;
  readonly size: number;
  readonly kind: "text" | "binary";
}

export interface SiteVersionView {
  readonly version: SiteVersionRow;
  readonly files: readonly VersionFile[];
  /** SKILL.md's frontmatter, or why it doesn't parse. */
  readonly frontmatter: Record<string, unknown> | null;
  readonly frontmatterProblem: string | null;
  readonly manifest: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly scan: Record<string, unknown>;
  readonly hashes: { readonly runtime: string; readonly package: string };
}

type StoredRow = {
  readonly skill_id: string;
  readonly manifest: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly scan: Record<string, unknown>;
  readonly package_hash: string;
  readonly package_storage_key: string | null;
  readonly runtime_hash: string;
  readonly runtime_storage_key: string | null;
  readonly runtime_size_bytes: number | null;
};

export const storedOf = (r: StoredRow): StoredPackage => ({
  packageHash: r.package_hash,
  packageStorageKey: r.package_storage_key,
  runtimeHash: r.runtime_hash,
  runtimeStorageKey: r.runtime_storage_key,
  runtimeSizeBytes: r.runtime_size_bytes,
});

export async function storedVersion(
  db: KobeDb | KobeTx,
  skillId: string,
  versionId: string,
): Promise<StoredRow | null> {
  const { rows } = await db.execute<StoredRow>(sql`
    SELECT skill_id, manifest, provenance, scan, package_hash, package_storage_key, runtime_hash,
      runtime_storage_key, runtime_size_bytes
      FROM registry_versions WHERE id = ${versionId} AND skill_id = ${skillId}`);
  return rows[0] ?? null;
}

/** Package files by path, verified; versions are immutable, so a few are kept unzipped. */
const filesCache = new Map<string, ReadonlyMap<string, Uint8Array>>();
const FILES_CACHE_MAX = 32;

export async function packageFiles(
  blobs: BlobStore,
  stored: StoredPackage,
): Promise<ReadonlyMap<string, Uint8Array> | null> {
  const hit = filesCache.get(stored.packageHash);
  if (hit) return hit;
  const zip = await readPackage(blobs, stored);
  if (!zip) return null;
  const files = new Map(Object.entries(unzipSync(zip)).filter(([p]) => !p.endsWith("/")));
  if (filesCache.size >= FILES_CACHE_MAX)
    filesCache.delete(filesCache.keys().next().value as string);
  filesCache.set(stored.packageHash, files);
  return files;
}

const isText = (bytes: Uint8Array): boolean => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

export async function siteVersionView(
  db: KobeDb,
  blobs: BlobStore,
  skillId: string,
  versionId: string,
): Promise<SiteVersionView | null> {
  const stored = await storedVersion(db, skillId, versionId);
  if (!stored) return null;
  const version = (await versionRows(db, skillId)).find((v) => v.id === versionId);
  if (!version) return null;
  const files = (await packageFiles(blobs, storedOf(stored))) ?? new Map<string, Uint8Array>();
  const md = files.get("SKILL.md");
  const parsed = md ? parseSkillMd(md) : "This version has no SKILL.md in the store.";
  return {
    version,
    files: [...files]
      .map(([path, bytes]) => ({
        path,
        size: bytes.length,
        kind: isText(bytes) ? ("text" as const) : ("binary" as const),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    frontmatter: typeof parsed === "string" ? null : parsed.frontmatter,
    frontmatterProblem: typeof parsed === "string" ? parsed : null,
    manifest: stored.manifest,
    provenance: stored.provenance,
    scan: stored.scan,
    hashes: { runtime: stored.runtime_hash, package: stored.package_hash },
  };
}

/** One file of a version, as the review screen shows it (text, escaped text or a hex dump). */
export async function siteVersionFile(
  db: KobeDb,
  blobs: BlobStore,
  skillId: string,
  versionId: string,
  path: string,
): Promise<RawFile | null> {
  const stored = await storedVersion(db, skillId, versionId);
  if (!stored) return null;
  const zip = await readPackage(blobs, storedOf(stored));
  return zip ? rawFile(zip, path) : null;
}
