import { createHash } from "node:crypto";
import { Inflate } from "fflate";
import { parse as parseYaml } from "yaml";
import {
  canonicalZip,
  checkPackagePaths,
  hashedPackageFiles,
  kobeSkillManifestSchema,
  MANIFEST_MAX_BYTES,
  MANIFEST_PATH,
  MANIFEST_YAML_OPTIONS,
  manifestMismatches,
  runtimeFiles,
  type KobeSkillManifest,
  type PackageProblem,
} from "@kobe/protocol";
import { SKILL_LIMITS, type SkillLimits } from "./limits.js";
import { parseSkillMd, type SkillMd } from "./skill-md.js";
import { readZipEntries, ZipFormatError, type ZipEntry } from "./zip-entries.js";

export type BundleErrorCode =
  | "bundle_too_large"
  | "too_many_files"
  | "file_too_large"
  | "bundle_too_expansive"
  | "invalid_zip"
  | "unsafe_path"
  | "duplicate_path"
  | "symlink_not_allowed"
  | "skill_md_missing"
  | "invalid_skill_md"
  /** A reserved root name in the wrong case, a file named `evals`, or an authored provenance.json. */
  | "reserved_path"
  /** A path that is both a file and a folder (KOBE-309). */
  | "path_conflict"
  | "invalid_manifest";

export interface BundleError {
  readonly code: BundleErrorCode;
  readonly message: string;
}

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BundleError };

export interface ValidBundle extends SkillMd {
  /**
   * The runtime zip (KOBE-309 contract): the canonical zip of the payload, without `evals/` and
   * `kobe.skill.yaml`, the single wrapper directory stripped. What is stored as the version's
   * bundle, hashed as its `content_hash` (= runtime hash) and served to sandboxes.
   */
  readonly zip: Uint8Array;
  /** The canonical package zip when it differs from `zip` (it has `evals/` or a manifest). */
  readonly packageZip: Uint8Array | null;
  /** SHA-256 of `packageZip`, or of `zip` when there is none. */
  readonly packageHash: string;
  /** The parsed `kobe.skill.yaml`, if the package has one (its name matches SKILL.md). */
  readonly manifest: KobeSkillManifest | null;
  /** Files and bytes of the runtime payload (what a sandbox unpacks). */
  readonly fileCount: number;
  readonly uncompressedBytes: number;
}

const fail = (code: BundleErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message },
});

const SKILL_MD_PATH = "SKILL.md";
const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Validates an uploaded skill zip without extracting it to disk (KOBE-78): size, file-count and
 * zip-bomb limits, safe relative paths only, no symlinks, SKILL.md at the root with a valid
 * frontmatter. Declared sizes are bounds, not facts: every entry is inflated with the declared
 * size as a hard stop, so a header that lies about its size is refused, not trusted.
 */
export function validateZipBundle(
  bytes: Uint8Array,
  limits: SkillLimits = SKILL_LIMITS,
): Result<ValidBundle> {
  if (bytes.length > limits.maxBundleBytes)
    return fail("bundle_too_large", `The bundle is larger than ${limits.maxBundleBytes} bytes.`);
  let entries: ZipEntry[];
  try {
    // NFC first: every later check, the wrapper strip and the stored names see one spelling.
    entries = readZipEntries(bytes, limits.maxFiles * 2).map((e) => ({
      ...e,
      name: e.name.normalize("NFC"),
    }));
  } catch (err) {
    return zipFailure(err);
  }
  const prefix = wrapperPrefix(entries);
  const named = prefix === null ? entries : entries.flatMap((e) => unwrap(e, prefix));
  const files = named.filter((e) => !e.isDirectory);
  if (files.length > limits.maxFiles)
    return fail("too_many_files", `A skill may have at most ${limits.maxFiles} files.`);
  const pathProblem = checkPaths(named, limits);
  if (pathProblem) return pathProblem;
  const sizeProblem = checkSizes(files, limits);
  if (sizeProblem) return sizeProblem;
  const contractProblem = checkContract(files.map((f) => f.name));
  if (contractProblem) return contractProblem;

  const contents = new Map<string, Uint8Array>();
  const budget = { remaining: limits.maxUncompressedBytes };
  for (const file of files) {
    const data = inflateEntry(bytes, file, budget);
    if (!data) return fail("invalid_zip", `${file.name} is corrupt or larger than it declares.`);
    contents.set(file.name, data);
  }
  const skillMd = contents.get(SKILL_MD_PATH);
  if (!skillMd)
    return fail(
      "skill_md_missing",
      "SKILL.md must be at the root of the bundle (or directly inside its single top-level folder).",
    );
  const parsed = parseSkillMd(skillMd);
  if (typeof parsed === "string") return fail("invalid_skill_md", parsed);
  const manifest = readManifest(contents.get(MANIFEST_PATH), parsed.name);
  if (!manifest.ok) return manifest;
  return { ok: true, value: { ...parsed, ...packageZips(contents), manifest: manifest.value } };
}

/** The runtime and package zips of a checked file set (KOBE-309 hashing rules). */
function packageZips(contents: ReadonlyMap<string, Uint8Array>) {
  const runtime = runtimeFiles(contents);
  const hashed = hashedPackageFiles(contents);
  const zip = canonicalZip(runtime);
  const packageZip = hashed.size === runtime.size ? null : canonicalZip(hashed);
  let uncompressedBytes = 0;
  for (const bytes of runtime.values()) uncompressedBytes += bytes.length;
  return {
    zip,
    packageZip,
    packageHash: sha256Hex(packageZip ?? zip),
    fileCount: runtime.size,
    uncompressedBytes,
  };
}

const PROBLEM_CODES: Partial<Record<PackageProblem["problem"], BundleErrorCode>> = {
  duplicate: "duplicate_path",
  file_and_directory: "path_conflict",
  reserved_name_case: "reserved_path",
  reserved_directory: "reserved_path",
  provenance_not_allowed: "reserved_path",
};

/**
 * The KOBE-309 path rules for authored content (no provenance.json), after the upload's own
 * checks: what they add is refused here with the first problem. A missing SKILL.md is reported
 * later, with its own message.
 */
function checkContract(names: readonly string[]): Result<never> | null {
  const problem = checkPackagePaths(names).find((p) => p.problem !== "skill_md_missing");
  if (!problem) return null;
  const code = PROBLEM_CODES[problem.problem] ?? "unsafe_path";
  const why =
    code === "reserved_path"
      ? `${printable(problem.path)} is reserved: only SKILL.md, evals/ and kobe.skill.yaml, spelled exactly so, are special, and Kobe writes provenance.json itself.`
      : code === "path_conflict"
        ? `${printable(problem.path)} is both a file and a folder.`
        : `Unsafe path in bundle: ${printable(problem.path)} (${problem.problem.replaceAll("_", " ")})`;
  return fail(code, why);
}

/**
 * Parses and checks `kobe.skill.yaml` by the contract's text rules; null when absent. Also used on
 * stored packages (KOBE-310 recompute and export), whose manifests were never read before.
 */
export function readManifest(
  bytes: Uint8Array | undefined,
  skillName: string,
): Result<KobeSkillManifest | null> {
  if (!bytes) return { ok: true, value: null };
  const bad = (why: string) => fail("invalid_manifest", `kobe.skill.yaml: ${why}`);
  if (bytes.length > MANIFEST_MAX_BYTES) return bad(`larger than ${MANIFEST_MAX_BYTES} bytes.`);
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    value = parseYaml(text, MANIFEST_YAML_OPTIONS);
  } catch {
    return bad("not valid UTF-8 YAML (one document, unique keys, no aliases).");
  }
  const parsed = kobeSkillManifestSchema.safeParse(value);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") || "(root)";
    return bad(`invalid at ${where}.`);
  }
  if (manifestMismatches(parsed.data, { name: skillName, semver: parsed.data.version }).length)
    return bad(`name must be the SKILL.md name, ${skillName}.`);
  return { ok: true, value: parsed.data };
}

/**
 * The one top-level directory every entry sits under, when there is no SKILL.md at the root: the
 * wrapper many zip tools add. Null when SKILL.md is already at the root, when entries have two
 * different top-level names, or when a file sits beside the directory.
 */
function wrapperPrefix(entries: readonly ZipEntry[]): string | null {
  if (entries.some((e) => e.name === SKILL_MD_PATH)) return null;
  const tops = new Set<string>();
  for (const { name } of entries) {
    const slash = name.indexOf("/");
    if (slash <= 0) return null;
    tops.add(name.slice(0, slash));
  }
  const [only] = tops;
  return tops.size === 1 && only !== undefined ? `${only}/` : null;
}

function unwrap(entry: ZipEntry, prefix: string): ZipEntry[] {
  // The wrapper directory's own entry disappears with the prefix.
  return entry.name === prefix ? [] : [{ ...entry, name: entry.name.slice(prefix.length) }];
}

/** Wraps a bare SKILL.md upload into a one-file zip, so every stored bundle is a zip. */
export function bundleFromSkillMd(
  bytes: Uint8Array,
  limits: SkillLimits = SKILL_LIMITS,
): Result<ValidBundle> {
  if (bytes.length > limits.maxSkillMdBytes)
    return fail("file_too_large", `SKILL.md may be at most ${limits.maxSkillMdBytes} bytes.`);
  const parsed = parseSkillMd(bytes);
  if (typeof parsed === "string") return fail("invalid_skill_md", parsed);
  return {
    ok: true,
    value: { ...parsed, ...packageZips(new Map([[SKILL_MD_PATH, bytes]])), manifest: null },
  };
}

function zipFailure(err: unknown): Result<never> {
  if (!(err instanceof ZipFormatError)) throw err;
  switch (err.reason) {
    case "too_many_files":
      return fail("too_many_files", "The bundle has too many entries.");
    case "symlink":
      return fail(
        "symlink_not_allowed",
        "Only regular files and directories are allowed in a skill bundle.",
      );
    case "unsupported_zip":
      return fail("invalid_zip", "Encrypted, zip64 and multi-disk archives are not supported.");
    default:
      return fail("invalid_zip", "That is not a valid zip file.");
  }
}

function checkPaths(entries: readonly ZipEntry[], limits: SkillLimits): Result<never> | null {
  const seen = new Set<string>();
  for (const { name } of entries) {
    if (!isSafePath(name, limits))
      return fail("unsafe_path", `Unsafe path in bundle: ${printable(name)}`);
    const key = name.replace(/\/$/, "").normalize("NFC").toLowerCase();
    if (seen.has(key))
      return fail("duplicate_path", `Duplicate path in bundle: ${printable(name)}`);
    seen.add(key);
  }
  return null;
}

function isSafePath(name: string, limits: SkillLimits): boolean {
  if (name === "" || Buffer.byteLength(name) > limits.maxPathBytes) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(name) || name.startsWith("/") || /^[a-zA-Z]:/.test(name))
    return false;
  const segments = name.replace(/\/$/, "").split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== ".." && s !== "__proto__");
}

function checkSizes(files: readonly ZipEntry[], limits: SkillLimits): Result<never> | null {
  let total = 0;
  let packed = 0;
  for (const f of files) {
    if (f.size > limits.maxFileBytes)
      return fail(
        "file_too_large",
        `${printable(f.name)} is larger than ${limits.maxFileBytes} bytes.`,
      );
    if (f.name === SKILL_MD_PATH && f.size > limits.maxSkillMdBytes)
      return fail("file_too_large", `SKILL.md may be at most ${limits.maxSkillMdBytes} bytes.`);
    // Deflate can't beat the stored size by more than its block overhead: a bigger compressed
    // size than that is a header that lies.
    if (f.compressedSize > f.size + f.size / 1000 + 64)
      return fail("invalid_zip", `${printable(f.name)} is larger compressed than it declares.`);
    if (expansive(f.size, f.compressedSize, limits))
      return fail("bundle_too_expansive", `${printable(f.name)} expands suspiciously.`);
    total += f.size;
    packed += f.compressedSize;
  }
  if (total > limits.maxUncompressedBytes)
    return fail(
      "file_too_large",
      `The bundle expands beyond ${limits.maxUncompressedBytes} bytes.`,
    );
  if (expansive(total, packed, limits))
    return fail("bundle_too_expansive", "The bundle expands suspiciously.");
  return null;
}

const expansive = (size: number, packed: number, limits: SkillLimits): boolean =>
  size > limits.ratioFloorBytes && size > Math.max(packed, 1) * limits.maxRatio;

const INFLATE_CHUNK = 16 * 1024;

/**
 * The entry's bytes, or null if it is corrupt or inflates past its declared size or the bundle's
 * remaining `budget`. Input goes in small chunks and the caps are checked as each piece of output
 * appears, so a bomb is aborted after at most a chunk's expansion, never fully inflated.
 */
function inflateEntry(
  zip: Uint8Array,
  entry: ZipEntry,
  budget: { remaining: number },
): Uint8Array | null {
  const raw = zip.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) {
    budget.remaining -= raw.length;
    return budget.remaining < 0 ? null : raw;
  }
  const out = new Uint8Array(entry.size);
  let written = 0;
  try {
    const inflate = new Inflate((chunk) => {
      budget.remaining -= chunk.length;
      if (written + chunk.length > entry.size || budget.remaining < 0)
        throw new RangeError("overrun");
      out.set(chunk, written);
      written += chunk.length;
    });
    for (let at = 0; at < raw.length || at === 0; at += INFLATE_CHUNK) {
      inflate.push(raw.subarray(at, at + INFLATE_CHUNK), at + INFLATE_CHUNK >= raw.length);
    }
  } catch {
    return null;
  }
  return written === entry.size ? out : null;
}

const printable = (name: string): string => JSON.stringify(name.slice(0, 80));
