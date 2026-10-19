import { createHash } from "node:crypto";
import { structuredPatch } from "diff";
import { unzipSync } from "fflate";
import type { BlobStore } from "../../retention/blobs.js";
import { readVerified } from "../blob-read.js";

/**
 * The review screen's diff (KOBE-334, SK23): a submitted package against the skill's currently
 * approved version, file by file, with a unified patch for each changed text file. Both packages
 * are read from the catalog store and verified against the hashes their rows record (never
 * trusted); `evals/` and `kobe.skill.yaml` are part of the package, so they are diffed too.
 */

/** Where a version's package zip is and how to verify it (its row's columns). */
export interface StoredPackage {
  readonly packageHash: string;
  readonly packageStorageKey: string | null;
  readonly runtimeHash: string;
  readonly runtimeStorageKey: string | null;
  readonly runtimeSizeBytes: number | null;
}

export type FileStatus = "added" | "removed" | "changed" | "unchanged";

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Lines with their unified-diff prefix (" ", "+", "-"). */
  readonly lines: readonly string[];
}

export interface FileDiff {
  readonly path: string;
  readonly status: FileStatus;
  readonly size: number;
  /** Has a NUL byte on either side: no line diff; the raw view shows a hex dump. */
  readonly binary: boolean;
  /**
   * Text with bytes that aren't valid UTF-8 (review-336 M1): diffed with each bad byte shown as
   * U+FFFD; the raw view shows them escaped (`\xE9`), so nothing hides behind "binary".
   */
  readonly notUtf8?: true;
  /**
   * Why a changed text file has no line diff (review H1): `too_large` (over {@link MAX_TEXT_BYTES}
   * or {@link MAX_DIFF_LINES} lines), `too_different` (the diff gave up at its time or edit
   * limit), `skipped` (the request's time or line budget ran out). Absent when it has one.
   */
  readonly notDiffed?: "too_large" | "too_different" | "skipped";
  readonly hunks: readonly DiffHunk[];
}

export interface PackageDiff {
  readonly files: readonly FileDiff[];
  /** Files that changed (added, removed or changed), the queue's "changed-file count". */
  readonly changedFiles: number;
  /** The patches stopped at {@link MAX_PATCH_LINES}: the rest of the files show their status only. */
  readonly truncated: boolean;
}

/**
 * Bounds on the line diff, which runs on the server's event loop (review H1: Myers is O(N·D), and
 * two 180 KB files that differ everywhere took minutes): a file over these sizes shows its status
 * only; each file's diff gives up after {@link FILE_TIMEOUT_MS} or {@link MAX_EDIT_LENGTH} edits;
 * the whole request stops diffing after {@link REQUEST_BUDGET_MS}.
 */
export const MAX_TEXT_BYTES = 128 * 1024;
export const MAX_DIFF_LINES = 5_000;
export const MAX_EDIT_LENGTH = 5_000;
export const FILE_TIMEOUT_MS = 250;
export const REQUEST_BUDGET_MS = 1_500;
/** Lines of patch across the whole diff, so a huge package can't make a huge response. */
export const MAX_PATCH_LINES = 20_000;
const CONTEXT_LINES = 3;

/** The version's package zip, verified; null when its bytes aren't stored. */
export async function readPackage(blobs: BlobStore, v: StoredPackage): Promise<Uint8Array | null> {
  if (v.packageStorageKey) return readVerified(blobs, v.packageStorageKey, v.packageHash, null);
  if (v.runtimeStorageKey)
    return readVerified(blobs, v.runtimeStorageKey, v.runtimeHash, v.runtimeSizeBytes);
  return null;
}

function filesOf(zip: Uint8Array | null): Map<string, Uint8Array> {
  if (!zip) return new Map();
  return new Map(Object.entries(unzipSync(zip)).filter(([path]) => !path.endsWith("/")));
}

const strict = new TextDecoder("utf-8", { fatal: true });
const lossy = new TextDecoder("utf-8");

/** Whether `bytes` are valid UTF-8. */
export function isUtf8(bytes: Uint8Array): boolean {
  try {
    strict.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The file as text (invalid bytes as U+FFFD), or null when it is binary (has a NUL byte). */
function textOf(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return "";
  if (bytes.includes(0)) return null;
  return lossy.decode(bytes);
}

/** Over {@link MAX_TEXT_BYTES}, or more lines than {@link MAX_DIFF_LINES} (newline bytes). */
function tooLarge(bytes: Uint8Array | undefined): boolean {
  if (!bytes) return false;
  if (bytes.length > MAX_TEXT_BYTES) return true;
  let lines = 0;
  for (const byte of bytes) if (byte === 10 && ++lines > MAX_DIFF_LINES) return true;
  return false;
}

/**
 * The queue's changed-file count (review H1): a byte comparison per path, no line diff, so listing
 * the queue never diffs anything.
 */
export function changedFileCount(before: Uint8Array | null, after: Uint8Array): number {
  const old = filesOf(before);
  const next = filesOf(after);
  let n = 0;
  for (const path of new Set([...old.keys(), ...next.keys()]))
    if (statusOf(old.get(path), next.get(path)) !== "unchanged") n += 1;
  return n;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

function statusOf(before: Uint8Array | undefined, after: Uint8Array | undefined): FileStatus {
  if (!before) return "added";
  if (!after) return "removed";
  return sameBytes(before, after) ? "unchanged" : "changed";
}

const ORDER: Readonly<Record<FileStatus, number>> = {
  changed: 0,
  added: 1,
  removed: 2,
  unchanged: 3,
};

/**
 * What a reviewer must read first (review-335 M2): the instructions and manifest, then scripts,
 * then everything else; so decoy data files can't use up the request's budget before them.
 */
/** Files an agent may run, by extension (review-336 L7). */
const CODE = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|lua|r|go|rs)$/i;

export function readingRank(path: string): number {
  if (path === "SKILL.md") return 0;
  if (path === "kobe.skill.yaml") return 1;
  if (path.startsWith("scripts/") || path.startsWith("bin/") || CODE.test(path)) return 2;
  return 3;
}

/** One file's diff, given its bytes on both sides and the time it may take. */
function fileDiff(
  path: string,
  status: FileStatus,
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
  timeoutMs: number,
): FileDiff {
  const size = (b ?? a)?.length ?? 0;
  const textA = textOf(a);
  const textB = textOf(b);
  const binary = textA === null || textB === null;
  const notUtf8 =
    !binary && ((a && !isUtf8(a)) || (b && !isUtf8(b))) ? ({ notUtf8: true } as const) : {};
  if (binary || status === "unchanged")
    return { path, status, size, binary, ...notUtf8, hunks: [] };
  if (tooLarge(a) || tooLarge(b))
    return { path, status, size, binary, ...notUtf8, notDiffed: "too_large", hunks: [] };
  const patch = structuredPatch(path, path, textA, textB, "", "", {
    context: CONTEXT_LINES,
    timeout: Math.max(1, timeoutMs),
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (!patch)
    return { path, status, size, binary, ...notUtf8, notDiffed: "too_different", hunks: [] };
  const hunks = patch.hunks.map((h) => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }));
  return { path, status, size, binary, ...notUtf8, hunks };
}

/**
 * `after` against `before` (null: a new skill, every file added). SKILL.md, kobe.skill.yaml and
 * `scripts/` come first (review-335 M2), then the rest; within each, changed, added, removed and
 * unchanged files, each by path. A file the request's budget didn't reach is `skipped`: the review
 * screen loads it on its own (`diffOneFile`).
 */
export function diffPackages(before: Uint8Array | null, after: Uint8Array): PackageDiff {
  const old = filesOf(before);
  const next = filesOf(after);
  const paths = [...new Set([...old.keys(), ...next.keys()])];
  const entries = paths
    .map((path) => ({ path, status: statusOf(old.get(path), next.get(path)) }))
    .sort(
      (a, b) =>
        readingRank(a.path) - readingRank(b.path) ||
        ORDER[a.status] - ORDER[b.status] ||
        (a.path < b.path ? -1 : 1),
    );
  let budget = MAX_PATCH_LINES;
  let truncated = false;
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  const files = entries.map(({ path, status }): FileDiff => {
    const a = old.get(path);
    const b = next.get(path);
    if (status !== "unchanged" && (budget <= 0 || Date.now() >= deadline)) {
      // Past the budget: byte checks only, never a decode or a diff (review-335 L1).
      const size = (b ?? a)?.length ?? 0;
      const binary = !!a?.includes(0) || !!b?.includes(0);
      if (binary) return { path, status, size, binary, hunks: [] };
      if (tooLarge(a) || tooLarge(b))
        return { path, status, size, binary, notDiffed: "too_large", hunks: [] };
      truncated = true;
      return { path, status, size, binary: false, notDiffed: "skipped", hunks: [] };
    }
    const d = fileDiff(path, status, a, b, Math.min(FILE_TIMEOUT_MS, deadline - Date.now()));
    budget -= d.hunks.reduce((n, h) => n + h.lines.length, 0);
    return d;
  });
  return {
    files,
    changedFiles: entries.filter((e) => e.status !== "unchanged").length,
    truncated,
  };
}

/**
 * One file's diff on its own (the review screen's "Load diff" for a skipped file), with a whole
 * request's budget; null when neither side has the path.
 */
export function diffOneFile(
  before: Uint8Array | null,
  after: Uint8Array,
  path: string,
): FileDiff | null {
  const a = filesOf(before).get(path);
  const b = filesOf(after).get(path);
  if (!a && !b) return null;
  return fileDiff(path, statusOf(a, b), a, b, REQUEST_BUDGET_MS);
}

/** Largest file text the raw view returns (a too-large or too-different file, review-335 M2). */
export const MAX_RAW_BYTES = 1024 * 1024;

export interface RawFile {
  readonly path: string;
  readonly size: number;
  /** SHA-256 of the whole file, to compare with what runs. */
  readonly sha256: string;
  /**
   * `text`: valid UTF-8; `escaped`: text with each invalid byte as `\xNN`; `hex`: a hex dump (the
   * file has a NUL byte).
   */
  readonly encoding: "text" | "escaped" | "hex";
  readonly text: string;
  /** Only the first {@link MAX_RAW_BYTES} are shown. */
  readonly truncated: boolean;
}

/** `bytes` as text with every byte that isn't part of valid UTF-8 written `\xNN`. */
export function escapeInvalid(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    const len =
      b < 0x80
        ? 1
        : b >= 0xc2 && b < 0xe0
          ? 2
          : b >= 0xe0 && b < 0xf0
            ? 3
            : b >= 0xf0 && b < 0xf5
              ? 4
              : 0;
    const seq = len > 0 ? bytes.subarray(i, i + len) : null;
    if (seq && seq.length === len && isUtf8(seq)) {
      out += strict.decode(seq);
      i += len;
    } else {
      out += `\\x${b.toString(16).toUpperCase().padStart(2, "0")}`;
      i += 1;
    }
  }
  return out;
}

/** A hex dump: offset, 16 bytes, and their printable ASCII. */
export function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const row = bytes.subarray(at, at + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${at.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}

/** Largest hex dump the raw view returns (a dump is about 4 times the bytes). */
export const MAX_HEX_BYTES = 64 * 1024;

/**
 * A file of the submitted package for a reviewer to read whole (review-335 M2, review-336 M1):
 * text, escaped text or a hex dump, with its hash; null when absent.
 */
export function rawFile(after: Uint8Array, path: string): RawFile | null {
  const bytes = filesOf(after).get(path);
  if (!bytes) return null;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.includes(0)) {
    const head = bytes.subarray(0, MAX_HEX_BYTES);
    return {
      path,
      size: bytes.length,
      sha256,
      encoding: "hex",
      text: hexDump(head),
      truncated: bytes.length > MAX_HEX_BYTES,
    };
  }
  const head = bytes.subarray(0, MAX_RAW_BYTES);
  const valid = isUtf8(bytes);
  return {
    path,
    size: bytes.length,
    sha256,
    encoding: valid ? "text" : "escaped",
    text: valid ? lossy.decode(head) : escapeInvalid(head),
    truncated: bytes.length > MAX_RAW_BYTES,
  };
}
