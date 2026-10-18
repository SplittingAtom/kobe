import { z } from "zod";
import {
  packagePathProblem,
  SEMVER_PATTERN,
  SHA256_HEX_PATTERN,
  SKILL_NAME_PATTERN,
  UUID_PATTERN,
} from "./layout.js";

/**
 * `provenance.json` (KOBE-309, spec SK19/SK30): Kobe-generated at promotion, never author-edited.
 * Where the package came from, who submitted it, what the scanner said, the scorecard **numbers
 * only** (never eval transcripts, prompts, answers or test threads: those stay in the team), and
 * both hashes. Written as canonical JSON (RFC 8785, `canonicalJson`) in UTF-8, at most
 * {@link PROVENANCE_MAX_BYTES}. Outside both hashes, since it names them.
 *
 * It is **unsigned**: anyone who handles an exported or mirrored package can edit it without
 * changing a hash. So its fields are of three kinds:
 *  - verifiable against the package beside it ({@link provenanceMismatches}): `name`, `version`,
 *    `hashes`, and `scorecard.packageHash` (freshness);
 *  - Kobe-attested, authoritative only in Kobe's own records, never read back from a file:
 *    `source`, `submitter`, `confirmedBy`, `scan`, the scorecard numbers, `origin`;
 *  - informational: `fromConversation`, `createdAt`.
 * Kobe never trusts an incoming `provenance.json` (uploads, drafts and imports refuse one;
 * `checkPackagePaths`) and writes its own from its records whenever it exports a package.
 */

export const PROVENANCE_API_VERSION = "kobe.dev/skill-provenance/v1";
export const PROVENANCE_MAX_BYTES = 256 * 1024;
export const MAX_PROVENANCE_FINDINGS = 500;

const sha256 = z.string().regex(SHA256_HEX_PATTERN);
const semver = z.string().regex(SEMVER_PATTERN);
const uuid = z.string().regex(UUID_PATTERN);
/** ISO 8601 instant in UTC with milliseconds, exactly as `Date.prototype.toISOString` writes it. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const instant = z.string().refine((s) => {
  if (!INSTANT.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString() === s;
}, "an instant as toISOString writes it");

/**
 * Where an import came from: `https`, no credentials (userinfo), no query or fragment (tokens
 * travel there), as the URL parser normalizes it. Provenance goes into exports and the mirror.
 */
const originUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return false;
    }
    return (
      u.protocol === "https:" &&
      u.username === "" &&
      u.password === "" &&
      u.search === "" &&
      u.hash === "" &&
      !s.includes("?") &&
      !s.includes("#") &&
      u.href === s
    );
  }, "an https URL without credentials, query or fragment");
const ratio = z.number().min(0).max(1);
const count = z.number().int().min(0);

export const SCAN_VERDICTS = ["pass", "caution", "block"] as const;

export const provenanceSchema = z.strictObject({
  apiVersion: z.literal(PROVENANCE_API_VERSION),
  name: z.string().regex(SKILL_NAME_PATTERN),
  version: semver,
  hashes: z.strictObject({ runtime: sha256, package: sha256 }),
  /** The local version promoted (team or personal), with its team: the source team (SK24). */
  source: z.strictObject({
    scope: z.enum(["team", "personal"]),
    teamId: uuid,
    skillId: uuid,
    seq: z.number().int().positive(),
    semver,
  }),
  submitter: z.strictObject({ userId: uuid, at: instant }),
  /** Confirmed by a Team admin for a Builder's request (SK19). */
  confirmedBy: z.strictObject({ userId: uuid, at: instant }).optional(),
  /** The draft started from a conversation (SK19 shows it before anything leaves the team). */
  fromConversation: z.boolean(),
  /** A governed import (SK30): the fetched URL and commit, re-hashed by the server. */
  origin: z
    .strictObject({
      kind: z.enum(["git", "zip"]),
      url: originUrl,
      commit: z
        .string()
        .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)
        .optional(),
      fetchedSha256: sha256,
    })
    .optional(),
  scan: z.strictObject({
    scanner: z.strictObject({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      version: z.string().min(1).max(64),
      rulesVersion: z.string().min(1).max(64),
    }),
    verdict: z.enum(SCAN_VERDICTS),
    /** Locations only: no excerpt of the content (the reviewer reads the package). */
    findings: z
      .array(
        z.strictObject({
          category: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
          rule: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
          file: z.string().refine((f) => packagePathProblem(f) === null, "not a package path"),
          line: z.number().int().min(0),
        }),
      )
      .max(MAX_PROVENANCE_FINDINGS),
  }),
  /** Numbers only (SK19), from an eval of this exact package hash (SK20 freshness). */
  scorecard: z
    .strictObject({
      packageHash: sha256,
      mode: z.enum(["full", "with_only"]),
      cases: count,
      negativeTriggerCases: count,
      passRateWith: ratio,
      passRateWithout: ratio.optional(),
      lift: z.number().min(-1).max(1).optional(),
      triggerPrecision: ratio,
      triggerRecall: ratio,
      costUsd: z.number().min(0).max(1_000_000),
      at: instant,
    })
    .optional(),
  createdAt: instant,
});

export type SkillProvenance = z.infer<typeof provenanceSchema>;

export type ProvenanceMismatch = "name" | "version" | "runtime_hash" | "package_hash" | "scorecard";

/**
 * Fields of a valid provenance that disagree with the package beside it. The scorecard counts only
 * when it was made from the same package hash (otherwise it is stale and must be re-run).
 */
export function provenanceMismatches(
  provenance: SkillProvenance,
  actual: {
    readonly name: string;
    readonly semver: string;
    readonly runtimeHash: string;
    readonly packageHash: string;
  },
): ProvenanceMismatch[] {
  const out: ProvenanceMismatch[] = [];
  if (provenance.name !== actual.name) out.push("name");
  if (provenance.version !== actual.semver) out.push("version");
  if (provenance.hashes.runtime !== actual.runtimeHash) out.push("runtime_hash");
  if (provenance.hashes.package !== actual.packageHash) out.push("package_hash");
  if (provenance.scorecard && provenance.scorecard.packageHash !== actual.packageHash)
    out.push("scorecard");
  return out;
}
