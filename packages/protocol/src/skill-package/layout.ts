/**
 * The skill package (KOBE-309, spec SK14/SK19/SK29): the files of one skill version, as
 * promotion, the Registry and the git mirror carry it.
 *
 *   SKILL.md            required; the portable skill (Agent Skills format)     runtime
 *   scripts/ references/ assets/ (and any other path)                          runtime
 *   evals/              eval suite: cases.yaml, fixtures/ (KOBE-324)           package only
 *   kobe.skill.yaml     author-edited registry metadata (manifest.ts)          package only
 *   provenance.json     Kobe-generated at promotion (provenance.ts)            neither hash
 *
 * Three file sets, all addressed by path → bytes:
 *  - the **runtime payload**: every file except `evals/**`, `kobe.skill.yaml` and
 *    `provenance.json`. Its canonical zip is the bundle a sandbox gets (`--skill <dir>`), and its
 *    SHA-256, the **runtime hash**, is the skill's identity everywhere (blocklist, resolver,
 *    materialization): the `content_hash` columns.
 *  - the **hashed package**: every file except `provenance.json`. Its SHA-256 is the **package
 *    hash** (scorecard freshness, Registry versions, the package zip in the object store).
 *  - `provenance.json` describes both hashes, so neither covers it; Kobe writes it next to the
 *    package when it exports or mirrors one.
 *
 * Only the root names are reserved: `scripts/evals/x` is payload, `evals/x` is not.
 */

export const SKILL_MD_PATH = "SKILL.md";
export const MANIFEST_PATH = "kobe.skill.yaml";
export const PROVENANCE_PATH = "provenance.json";
export const EVALS_DIR = "evals/";
/** Conventional payload directories (Agent Skills); other paths are allowed too. */
export const PAYLOAD_DIRS = ["scripts/", "references/", "assets/"] as const;

/** A skill name: the SKILL.md frontmatter `name`, catalog names, `<name>/v<semver>` git tags. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
/** MAJOR.MINOR.PATCH, each at most nine digits, no leading zeros, no pre-release or build. */
export const SEMVER_PATTERN = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
/** A Kobe id (users, teams, skills): a lowercase UUID. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Lowercase hex SHA-256: runtime and package hashes. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/** Longest path, in UTF-8 bytes (the server's upload limit since KOBE-78). */
export const MAX_PACKAGE_PATH_BYTES = 240;

export type PackageFileRole = "runtime" | "evals" | "manifest" | "provenance";

export function packageFileRole(path: string): PackageFileRole {
  if (path === MANIFEST_PATH) return "manifest";
  if (path === PROVENANCE_PATH) return "provenance";
  if (path.startsWith(EVALS_DIR)) return "evals";
  return "runtime";
}

export type PackageFiles = ReadonlyMap<string, Uint8Array>;

const pick = (files: PackageFiles, keep: (role: PackageFileRole) => boolean): PackageFiles =>
  new Map([...files].filter(([path]) => keep(packageFileRole(path))));

/** The runtime payload: what the runtime hash covers and a sandbox receives. */
export const runtimeFiles = (files: PackageFiles): PackageFiles =>
  pick(files, (role) => role === "runtime");

/** Everything the package hash covers: the payload, `evals/` and `kobe.skill.yaml`. */
export const hashedPackageFiles = (files: PackageFiles): PackageFiles =>
  pick(files, (role) => role !== "provenance");

export type PackagePathProblem =
  | "empty"
  | "too_long"
  | "not_nfc"
  | "absolute"
  | "control_or_backslash"
  | "bad_segment"
  | "duplicate"
  | "reserved_directory";

/**
 * Why `path` can't be a package file, or null. Paths are relative, `/`-separated, NFC, at most
 * {@link MAX_PACKAGE_PATH_BYTES} UTF-8 bytes, with no empty, `.`, `..` or `__proto__` segment,
 * no control character or backslash, no leading `/` or drive letter, and no trailing `/`
 * (directories are implied, never entries).
 */
export function packagePathProblem(path: string): PackagePathProblem | null {
  if (path === "") return "empty";
  if (new TextEncoder().encode(path).length > MAX_PACKAGE_PATH_BYTES) return "too_long";
  if (path.normalize("NFC") !== path) return "not_nfc";
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return "absolute";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return "control_or_backslash";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s === "__proto__"))
    return "bad_segment";
  return null;
}

export interface PackageProblem {
  readonly path: string;
  readonly problem: PackagePathProblem | "skill_md_missing";
}

/**
 * Every problem with a package's file set: bad paths, two paths that differ only by case (they
 * collide on case-insensitive filesystems), a file where a reserved directory must be (`evals`),
 * or no SKILL.md at the root. Empty when the set is a valid package (contents not checked here).
 */
export function checkPackagePaths(paths: Iterable<string>): PackageProblem[] {
  const problems: PackageProblem[] = [];
  const seen = new Set<string>();
  let skillMd = false;
  for (const path of paths) {
    if (path === SKILL_MD_PATH) skillMd = true;
    const problem = packagePathProblem(path);
    if (problem) {
      problems.push({ path, problem });
      continue;
    }
    if (path === EVALS_DIR.slice(0, -1)) problems.push({ path, problem: "reserved_directory" });
    const key = path.toLowerCase();
    if (seen.has(key)) problems.push({ path, problem: "duplicate" });
    seen.add(key);
  }
  if (!skillMd) problems.push({ path: SKILL_MD_PATH, problem: "skill_md_missing" });
  return problems;
}
