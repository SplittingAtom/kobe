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
  | "not_well_formed"
  | "not_nfc"
  | "absolute"
  | "control_or_backslash"
  | "invisible_or_bidi"
  | "bad_segment";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** C1 controls, zero-width and bidi controls: they spoof how a path reads in review. */
const INVISIBLE = /[\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/**
 * Why `path` can't be a package file, or null. Paths are well-formed Unicode (no lone
 * surrogates: two of them would encode to the same UTF-8 name), in NFC (refused otherwise, never
 * normalized: the caller's spelling is the stored one), at most {@link MAX_PACKAGE_PATH_BYTES}
 * UTF-8 bytes, relative and `/`-separated with no empty, `.`, `..` or `__proto__` segment, no
 * C0/C1 control, backslash, zero-width or bidi control character, no leading `/` or drive letter,
 * and no trailing `/` (directories are implied, never entries).
 */
export function packagePathProblem(path: string): PackagePathProblem | null {
  if (path === "") return "empty";
  if (LONE_SURROGATE.test(path)) return "not_well_formed";
  if (new TextEncoder().encode(path).length > MAX_PACKAGE_PATH_BYTES) return "too_long";
  if (path.normalize("NFC") !== path) return "not_nfc";
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return "absolute";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return "control_or_backslash";
  if (INVISIBLE.test(path)) return "invisible_or_bidi";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s === "__proto__"))
    return "bad_segment";
  return null;
}

export type PackageProblemCode =
  | PackagePathProblem
  | "duplicate"
  | "file_and_directory"
  | "reserved_name_case"
  | "reserved_directory"
  | "provenance_not_allowed"
  | "skill_md_missing";

export interface PackageProblem {
  readonly path: string;
  readonly problem: PackageProblemCode;
}

export interface CheckPackageOptions {
  /**
   * Accept a root `provenance.json`: only for a package Kobe assembled itself (export, mirror).
   * Authored content (uploads, drafts, imports, built-ins) never carries one: an incoming one is
   * refused, and Kobe writes its own.
   */
  readonly kobeProvenance?: boolean;
}

/** The reserved root names, exact spelling; case variants are refused (`reserved_name_case`). */
const RESERVED_ROOT = [SKILL_MD_PATH, MANIFEST_PATH, PROVENANCE_PATH, EVALS_DIR.slice(0, -1)];
const RESERVED_BY_FOLD = new Map(RESERVED_ROOT.map((name) => [fold(name), name]));

/**
 * Case folding for collisions: the lowercase of the uppercase (JavaScript's default Unicode
 * mappings), so `ς`/`σ` and `ß`/`ss` collide too. Affects validity only, never hashes.
 */
function fold(s: string): string {
  return s.toUpperCase().toLowerCase();
}

/**
 * Every problem with a package's file set, empty when it is valid (contents are not checked):
 *  - a bad path ({@link packagePathProblem});
 *  - two paths equal under case folding (they collide on case-insensitive filesystems);
 *  - a path that is both a file and a directory (`scripts` and `scripts/x`, case-folded): no
 *    filesystem or git tree can hold both;
 *  - a root name that is a case variant of a reserved one (`Evals/`, `KOBE.SKILL.YAML`,
 *    `skill.md`): refused rather than treated as payload or as reserved, so an author on a
 *    case-insensitive filesystem never ships evals into the runtime by accident;
 *  - a file named `evals` (the directory is reserved);
 *  - a `provenance.json` without {@link CheckPackageOptions.kobeProvenance};
 *  - no `SKILL.md` at the root.
 */
export function checkPackagePaths(
  paths: Iterable<string>,
  options: CheckPackageOptions = {},
): PackageProblem[] {
  const problems: PackageProblem[] = [];
  const files = new Set<string>();
  const dirs = new Set<string>();
  let skillMd = false;
  const valid: string[] = [];
  for (const path of paths) {
    const problem = packagePathProblem(path);
    if (problem) {
      problems.push({ path, problem });
      continue;
    }
    valid.push(path);
    const key = fold(path);
    if (files.has(key)) problems.push({ path, problem: "duplicate" });
    files.add(key);
    const segments = key.split("/");
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
  }
  for (const path of valid) {
    const key = fold(path);
    const segments = key.split("/");
    const parent = segments
      .slice(0, -1)
      .map((_, i) => segments.slice(0, i + 1).join("/"))
      .find((prefix) => files.has(prefix));
    if (dirs.has(key) || parent !== undefined)
      problems.push({ path, problem: "file_and_directory" });
    const root = path.split("/")[0] as string;
    const reserved = RESERVED_BY_FOLD.get(fold(root));
    if (reserved !== undefined && reserved !== root)
      problems.push({ path, problem: "reserved_name_case" });
    if (path === SKILL_MD_PATH) skillMd = true;
    if (path === EVALS_DIR.slice(0, -1)) problems.push({ path, problem: "reserved_directory" });
    if (path === PROVENANCE_PATH && !options.kobeProvenance)
      problems.push({ path, problem: "provenance_not_allowed" });
  }
  if (!skillMd) problems.push({ path: SKILL_MD_PATH, problem: "skill_md_missing" });
  return problems;
}

/** Thrown by the canonical zip and the hashes for a file set that is not a valid package. */
export class SkillPackageError extends Error {
  constructor(readonly problems: readonly PackageProblem[]) {
    super(
      `not a valid skill package: ${problems
        .slice(0, 5)
        .map((p) => `${JSON.stringify(p.path)} ${p.problem}`)
        .join(", ")}`,
    );
    this.name = "SkillPackageError";
  }
}

/** Throws {@link SkillPackageError} unless `files` is a valid package. */
export function assertPackagePaths(
  paths: Iterable<string>,
  options: CheckPackageOptions = {},
): void {
  const problems = checkPackagePaths(paths, options);
  if (problems.length > 0) throw new SkillPackageError(problems);
}
