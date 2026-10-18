import type { SkillRecord, SkillVersionRecord } from "../skills/store.js";

/** A skill as the skill routes return it (KOBE-78, KOBE-308). */
export const skillJson = (s: SkillRecord) => ({
  id: s.id,
  scope: s.scope,
  slug: s.slug,
  description: s.description,
  latestVersion: s.latestVersion,
  latestSemver: s.latestSemver,
  access: s.access,
  archivedAt: s.archivedAt,
  ownerUserId: s.ownerUserId,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

/** Review state of a team version (personal versions have none: they are not reviewed). */
export interface ReviewState {
  readonly status: string;
  readonly flagged: boolean;
}

export const versionJson = (v: SkillVersionRecord, review: ReviewState | null = null) => ({
  version: v.version,
  seq: v.seq,
  semver: v.semver,
  changelog: v.changelog,
  packageHash: v.packageHash,
  frontmatter: v.frontmatter,
  source: v.source,
  contentHash: v.contentHash,
  sizeBytes: v.sizeBytes,
  fileCount: v.fileCount,
  uncompressedBytes: v.uncompressedBytes,
  uploadedBy: v.uploadedBy,
  uploadedAt: v.uploadedAt,
  review,
});
