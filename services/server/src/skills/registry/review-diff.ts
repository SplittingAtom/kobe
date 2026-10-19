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
  /** Not UTF-8 text: only the status is shown. */
  readonly binary: boolean;
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

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The file as text, or null when it is binary (a NUL, invalid UTF-8). */
function textOf(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return "";
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
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
export function readingRank(path: string): number {
  if (path === "SKILL.md") return 0;
  if (path === "kobe.skill.yaml") return 1;
  if (path.startsWith("scripts/")) return 2;
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
  if (binary || status === "unchanged") return { path, status, size, binary, hunks: [] };
  if (tooLarge(a) || tooLarge(b))
    return { path, status, size, binary, notDiffed: "too_large", hunks: [] };
  const patch = structuredPatch(path, path, textA, textB, "", "", {
    context: CONTEXT_LINES,
    timeout: Math.max(1, timeoutMs),
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (!patch) return { path, status, size, binary, notDiffed: "too_different", hunks: [] };
  const hunks = patch.hunks.map((h) => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }));
  return { path, status, size, binary, hunks };
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
  /** Null for a binary file. */
  readonly text: string | null;
  readonly truncated: boolean;
}

/** A file of the submitted package as text, for a reviewer to read whole; null when absent. */
export function rawFile(after: Uint8Array, path: string): RawFile | null {
  const bytes = filesOf(after).get(path);
  if (!bytes) return null;
  const head = bytes.subarray(0, MAX_RAW_BYTES);
  if (head.includes(0)) return { path, size: bytes.length, text: null, truncated: false };
  return {
    path,
    size: bytes.length,
    text: new TextDecoder("utf-8").decode(head),
    truncated: bytes.length > MAX_RAW_BYTES,
  };
}
