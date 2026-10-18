import { z } from "zod";
import { SEMVER_PATTERN, SKILL_NAME_PATTERN } from "./layout.js";

/**
 * `kobe.skill.yaml` (KOBE-309, spec SK19): the author-edited registry metadata of a skill
 * package. Kobe never loads it into a sandbox (it is outside the runtime hash) and nothing in it
 * grants anything: capabilities are checked against the team's egress and policy, never trusted
 * (no approval bypass).
 *
 * Text rules: UTF-8, at most {@link MANIFEST_MAX_BYTES} bytes, one YAML 1.2 document whose root is
 * a mapping, duplicate keys and aliases refused (see {@link MANIFEST_YAML_OPTIONS}). The parsed
 * value must match {@link kobeSkillManifestSchema}: unknown keys are refused, so a new field
 * needs a new contract (and a new `apiVersion` if old readers must refuse it).
 */

export const MANIFEST_API_VERSION = "kobe.dev/skill/v1";
export const MANIFEST_MAX_BYTES = 16 * 1024;
/** Options for eemeli/yaml `parse` that give the text rules above (no aliases, unique keys). */
export const MANIFEST_YAML_OPTIONS = {
  version: "1.2",
  schema: "core",
  uniqueKeys: true,
  maxAliasCount: 0,
  prettyErrors: false,
} as const;

/** Mirrors the server's changelog limit (KOBE-308) and the `*_changelog_size` checks. */
export const CHANGELOG_MAX_CHARS = 1024;
export const SUMMARY_MAX_CHARS = 280;
export const MAX_TAGS = 10;
export const MAX_MAINTAINERS = 20;
export const MAX_EGRESS_HOSTS = 50;
export const MAX_PACKAGES_PER_MANAGER = 50;

/** Topic tag: a slug from the Site vocabulary (unknown tags are proposals, not errors). */
export const TAG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
/** A maintainer: `user:<uuid>` (lowercase), a Kobe user id. */
export const MAINTAINER_PATTERN =
  /^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An SPDX license expression or `Proprietary` (letters, digits, `.-+:()` and spaces). */
export const LICENSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+\-:() ]{0,127}$/;
/** An exact DNS host name, lowercase, no port, no wildcard (as the team egress list). */
export const EGRESS_HOST_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** One requirement as its package manager writes it (`openpyxl==3.1.*`, `left-pad@^1`). */
export const PACKAGE_SPEC_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9._\-[\],=<>!~*^@/:+]{0,199}$/;
/** A version range (`>=1.2`, `1.0.x`): informational, matched by the resolver later. */
export const COMPATIBILITY_PATTERN = /^[0-9A-Za-z.*x^~<>=| -]{1,64}$/;

const unique = <T extends z.ZodType<string>>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .refine((xs) => new Set(xs).size === xs.length, "duplicate entry");

const packages = unique(z.string().regex(PACKAGE_SPEC_PATTERN), MAX_PACKAGES_PER_MANAGER);

export const kobeSkillManifestSchema = z.strictObject({
  apiVersion: z.literal(MANIFEST_API_VERSION),
  /** Must equal the SKILL.md frontmatter `name` ({@link manifestMismatches}). */
  name: z.string().regex(SKILL_NAME_PATTERN),
  /** Must equal the version's semver ({@link manifestMismatches}). */
  version: z.string().regex(SEMVER_PATTERN),
  summary: z.string().trim().min(1).max(SUMMARY_MAX_CHARS),
  tags: unique(z.string().regex(TAG_PATTERN), MAX_TAGS).optional(),
  /** Required at submission (SK20 rule "License field"); a draft may leave it out. */
  license: z.string().regex(LICENSE_PATTERN).optional(),
  /** Set by Kobe on approval (SK24); an author's list is a request, not a grant. */
  maintainers: unique(z.string().regex(MAINTAINER_PATTERN), MAX_MAINTAINERS).optional(),
  capabilities: z
    .strictObject({
      egress: unique(z.string().regex(EGRESS_HOST_PATTERN), MAX_EGRESS_HOSTS).optional(),
      packages: z.strictObject({ pip: packages.optional(), npm: packages.optional() }).optional(),
    })
    .optional(),
  compatibility: z
    .strictObject({
      kobe: z.string().regex(COMPATIBILITY_PATTERN).optional(),
      pi: z.string().regex(COMPATIBILITY_PATTERN).optional(),
    })
    .optional(),
  changelog: z.string().trim().min(1).max(CHANGELOG_MAX_CHARS).optional(),
});

export type KobeSkillManifest = z.infer<typeof kobeSkillManifestSchema>;

export type ManifestMismatch = "name" | "version";

/**
 * Fields of a valid manifest that disagree with the package it ships in: `name` must be the
 * SKILL.md frontmatter name and `version` the semver the version is saved as. Empty when they
 * agree; a package with mismatches is refused (the manifest never renames or renumbers).
 */
export function manifestMismatches(
  manifest: KobeSkillManifest,
  expected: { readonly name: string; readonly semver: string },
): ManifestMismatch[] {
  const out: ManifestMismatch[] = [];
  if (manifest.name !== expected.name) out.push("name");
  if (manifest.version !== expected.semver) out.push("version");
  return out;
}
