import { z } from "zod";

/**
 * Skill version numbers (KOBE-308, spec SK14): every version is MAJOR.MINOR.PATCH, strictly
 * increasing with its sequence number. No pre-release or build parts; each part at most nine
 * digits, no leading zeros. Mirrors the `*_semver_format` checks of migration 0130.
 */
const SEMVER = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

/** Mirrors `CHANGELOG_MAX` in @kobe/db's schema/skills.ts (the `*_changelog_size` checks). */
export const CHANGELOG_MAX = 1024;

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseSemver(value: string): Semver | null {
  const m = SEMVER.exec(value);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

const formatSemver = (v: Semver): string => `${v.major}.${v.minor}.${v.patch}`;

/** Negative, zero or positive as `a` is below, equal to or above `b`. Both must be valid. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`not a semver: ${x ? b : a}`);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

/** How versions uploaded before KOBE-308 read: version n is 0.n.0 (the migration's backfill). */
export const legacySemver = (version: number): string => `0.${version}.0`;

export type NextSemver =
  { readonly ok: true; readonly semver: string } | { readonly ok: false; readonly latest: string };

/**
 * The number of a new version: `requested` when it is above `latest` (refused otherwise), or by
 * default the next minor of `latest` (0.1.0 for a skill's first version), which keeps uploads
 * without a number in step with the 0.<n>.0 backfill.
 */
export function nextSemver(latest: string | null, requested: string | undefined): NextSemver {
  if (requested !== undefined) {
    return latest === null || compareSemver(requested, latest) > 0
      ? { ok: true, semver: requested }
      : { ok: false, latest };
  }
  const base = latest === null ? null : parseSemver(latest);
  return {
    ok: true,
    semver: base ? formatSemver({ ...base, minor: base.minor + 1, patch: 0 }) : "0.1.0",
  };
}

export const semverSchema = z
  .string()
  .regex(SEMVER, "Give the version as MAJOR.MINOR.PATCH, for example 1.2.0.");

export const changelogSchema = z.string().trim().min(1).max(CHANGELOG_MAX);
