import { Inflate, zipSync } from "fflate";
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
  | "invalid_skill_md";

export interface BundleError {
  readonly code: BundleErrorCode;
  readonly message: string;
}

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BundleError };

export interface ValidBundle extends SkillMd {
  readonly fileCount: number;
  readonly uncompressedBytes: number;
}

const fail = (code: BundleErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message },
});

const SKILL_MD_PATH = "SKILL.md";
/** Fixed timestamp so wrapping the same SKILL.md always gives the same bytes (and hash). */
const FIXED_MTIME = Date.UTC(2020, 0, 1);

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
    entries = readZipEntries(bytes, limits.maxFiles * 2);
  } catch (err) {
    return zipFailure(err);
  }
  const files = entries.filter((e) => !e.isDirectory);
  if (files.length > limits.maxFiles)
    return fail("too_many_files", `A skill may have at most ${limits.maxFiles} files.`);
  const pathProblem = checkPaths(entries, limits);
  if (pathProblem) return pathProblem;
  const sizeProblem = checkSizes(files, limits);
  if (sizeProblem) return sizeProblem;

  let skillMd: Uint8Array | undefined;
  for (const file of files) {
    const data = inflateEntry(bytes, file);
    if (!data) return fail("invalid_zip", `${file.name} is corrupt or larger than it declares.`);
    if (file.name === SKILL_MD_PATH) skillMd = data;
  }
  if (!skillMd) return fail("skill_md_missing", "SKILL.md must be at the root of the bundle.");
  const parsed = parseSkillMd(skillMd);
  if (typeof parsed === "string") return fail("invalid_skill_md", parsed);
  return {
    ok: true,
    value: { ...parsed, fileCount: files.length, uncompressedBytes: totalSize(files) },
  };
}

/** Wraps a bare SKILL.md upload into a one-file zip, so every stored bundle is a zip. */
export function bundleFromSkillMd(
  bytes: Uint8Array,
  limits: SkillLimits = SKILL_LIMITS,
): Result<ValidBundle & { readonly zip: Uint8Array }> {
  if (bytes.length > limits.maxSkillMdBytes)
    return fail("file_too_large", `SKILL.md may be at most ${limits.maxSkillMdBytes} bytes.`);
  const parsed = parseSkillMd(bytes);
  if (typeof parsed === "string") return fail("invalid_skill_md", parsed);
  const zip = zipSync({ [SKILL_MD_PATH]: [bytes, { mtime: FIXED_MTIME, level: 6 }] });
  return { ok: true, value: { ...parsed, fileCount: 1, uncompressedBytes: bytes.length, zip } };
}

function zipFailure(err: unknown): Result<never> {
  if (!(err instanceof ZipFormatError)) throw err;
  switch (err.reason) {
    case "too_many_files":
      return fail("too_many_files", "The bundle has too many entries.");
    case "symlink":
      return fail("symlink_not_allowed", "Symbolic links are not allowed in a skill bundle.");
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
    const key = name.replace(/\/$/, "").toLowerCase();
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
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
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

const totalSize = (files: readonly ZipEntry[]): number => files.reduce((n, f) => n + f.size, 0);

/** The entry's bytes, or null if it is corrupt or inflates past its declared size. */
function inflateEntry(zip: Uint8Array, entry: ZipEntry): Uint8Array | null {
  const raw = zip.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) return raw;
  const out = new Uint8Array(entry.size);
  let written = 0;
  try {
    const inflate = new Inflate((chunk) => {
      if (written + chunk.length > entry.size) throw new RangeError("overrun");
      out.set(chunk, written);
      written += chunk.length;
    });
    inflate.push(raw, true);
  } catch {
    return null;
  }
  return written === entry.size ? out : null;
}

const printable = (name: string): string => JSON.stringify(name.slice(0, 80));
