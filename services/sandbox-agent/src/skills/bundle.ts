import { crc32 } from "node:zlib";

/**
 * Strict reader for a canonical skill bundle (KOBE-78: the zip the server stored and hashed:
 * regular files only, stored without compression, no directory entries, no extra fields or
 * comments, SKILL.md at the root). kobe-sandbox-agent runs it on bytes whose SHA-256 already
 * matched the server's, and still re-applies every safety rule: the bytes come over a network
 * and are about to be written where model-run code reads them. Anything it can't vouch for is
 * refused, never guessed at (deflate, zip64, encryption, symlinks and other special files,
 * junk before or after the archive, unsafe or duplicate paths, size and count caps, bad CRCs).
 * Nothing is written here: it returns the files in memory.
 */

export interface BundleLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathBytes: number;
  readonly maxSkillMdBytes: number;
}

/** The server's upload caps (services/server skills/limits.ts), which no stored bundle exceeds. */
export const BUNDLE_LIMITS: BundleLimits = {
  maxFiles: 200,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  maxPathBytes: 240,
  maxSkillMdBytes: 100 * 1024,
};

export type BundleErrorReason =
  | "bad_zip"
  | "unsupported_zip"
  | "not_canonical"
  | "too_many_files"
  | "too_large"
  | "unsafe_path"
  | "duplicate_path"
  | "special_file"
  | "bad_checksum"
  | "no_skill_md";

export class BundleError extends Error {
  constructor(
    readonly reason: BundleErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "BundleError";
  }
}

export interface BundleFile {
  /** POSIX path relative to the skill directory, already checked safe. */
  readonly path: string;
  readonly data: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const FLAG_UTF8 = 0x800;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
export const SKILL_MD = "SKILL.md";

const fail = (reason: BundleErrorReason, message: string): never => {
  throw new BundleError(reason, message);
};

/** Parses and fully validates `zip`; throws {@link BundleError} on anything unexpected. */
export function readBundle(
  zip: Uint8Array,
  limits: BundleLimits = BUNDLE_LIMITS,
): readonly BundleFile[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (zip.length < EOCD_SIZE) fail("bad_zip", "bundle is too short to be a zip");
  // Canonical zips end with a bare end-of-central-directory record: no comment, no trailing bytes.
  const eocd = zip.length - EOCD_SIZE;
  if (view.getUint32(eocd, true) !== EOCD_SIG || view.getUint16(eocd + 20, true) !== 0)
    return fail("not_canonical", "bundle does not end with a bare end-of-archive record");
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (
    view.getUint16(eocd + 4, true) !== 0 ||
    view.getUint16(eocd + 6, true) !== 0 ||
    view.getUint16(eocd + 8, true) !== count ||
    count === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  )
    return fail("unsupported_zip", "multi-disk and zip64 archives are not supported");
  if (count === 0) return fail("no_skill_md", "bundle has no files");
  if (count > limits.maxFiles) return fail("too_many_files", "bundle has too many files");
  if (cdOffset + cdSize !== eocd) return fail("not_canonical", "junk around the central directory");

  const files: BundleFile[] = [];
  const seen = new Set<string>();
  let at = cdOffset;
  let total = 0;
  let expectedLocal = 0;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > eocd || view.getUint32(at, true) !== CENTRAL_SIG)
      return fail("bad_zip", "bad central directory record");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const attrs = view.getUint32(at + 38, true);
    const localOffset = view.getUint32(at + 42, true);
    const next = at + CENTRAL_SIZE + nameLen + extraLen + commentLen;
    if (next > eocd) return fail("bad_zip", "central directory record overruns the archive");
    if ((flags & ~FLAG_UTF8) !== 0 || method !== 0)
      return fail("not_canonical", "entries must be stored plain (no compression or encryption)");
    if (extraLen !== 0 || commentLen !== 0)
      return fail("not_canonical", "entries must carry no extra fields or comments");
    if (packed !== size || packed === 0xffffffff || localOffset === 0xffffffff)
      return fail("unsupported_zip", "zip64 or inconsistent sizes");
    // Whatever OS the archive claims, only a regular file (or no type at all) is acceptable.
    const type = (attrs >>> 16) & S_IFMT;
    if (type !== 0 && type !== S_IFREG)
      return fail("special_file", "only regular files are allowed in a skill bundle");
    const path = decodeName(zip.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLen));
    checkPath(path, limits);
    const folded = path.toLowerCase();
    if (seen.has(folded)) return fail("duplicate_path", `duplicate path: ${printable(path)}`);
    seen.add(folded);
    if (size > limits.maxFileBytes || (path === SKILL_MD && size > limits.maxSkillMdBytes))
      return fail("too_large", `${printable(path)} is too large`);
    total += size;
    if (total > limits.maxTotalBytes) return fail("too_large", "bundle expands too far");

    // The local header must agree with the central one, and the data must follow it directly
    // (entries are laid out back to back in canonical zips: no gaps to hide bytes in).
    if (localOffset !== expectedLocal) return fail("not_canonical", "gap between entries");
    if (localOffset + LOCAL_SIZE > cdOffset || view.getUint32(localOffset, true) !== LOCAL_SIG)
      return fail("bad_zip", "bad local header");
    const localNameLen = view.getUint16(localOffset + 26, true);
    if (view.getUint16(localOffset + 28, true) !== 0 || localNameLen !== nameLen)
      return fail("not_canonical", "local header disagrees with the central directory");
    const nameAt = localOffset + LOCAL_SIZE;
    if (!sameBytes(zip.subarray(nameAt, nameAt + nameLen), zip.subarray(at + CENTRAL_SIZE, next)))
      return fail("bad_zip", "local header names another file");
    const dataAt = nameAt + nameLen;
    if (dataAt + size > cdOffset) return fail("bad_zip", "entry data overruns the archive");
    const data = zip.subarray(dataAt, dataAt + size);
    if (crc32(data) !== crc) return fail("bad_checksum", `${printable(path)} fails its checksum`);
    expectedLocal = dataAt + size;
    files.push({ path, data });
    at = next;
  }
  if (expectedLocal !== cdOffset) return fail("not_canonical", "bytes between data and directory");
  checkTree(files);
  if (!seen.has(SKILL_MD.toLowerCase()) || !files.some((f) => f.path === SKILL_MD))
    return fail("no_skill_md", "SKILL.md is missing at the bundle root");
  return files;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("unsafe_path", "a file name is not valid UTF-8");
  }
}

function checkPath(name: string, limits: BundleLimits): void {
  const bad =
    name === "" ||
    Buffer.byteLength(name) > limits.maxPathBytes ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f\\]/.test(name) ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    /^[a-zA-Z]:/.test(name) ||
    name !== name.normalize("NFC") ||
    name.split("/").some((s) => s === "" || s === "." || s === ".." || s === "__proto__");
  if (bad) fail("unsafe_path", `unsafe path in bundle: ${printable(name)}`);
}

/** A path may not be both a file and the parent directory of another (it can't be extracted). */
function checkTree(files: readonly BundleFile[]): void {
  const paths = new Set(files.map((f) => f.path.toLowerCase()));
  for (const { path } of files) {
    const parts = path.toLowerCase().split("/");
    for (let n = 1; n < parts.length; n++) {
      if (paths.has(parts.slice(0, n).join("/")))
        fail("duplicate_path", `${printable(path)} sits under a file`);
    }
  }
}

/** A path safe to put into an error message (control characters made visible, length capped). */
function printable(name: string): string {
  // eslint-disable-next-line no-control-regex
  return JSON.stringify(name.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 80));
}
