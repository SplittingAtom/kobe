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
  /** Not UTF-8 text, or too large to diff line by line: only the status is shown. */
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
}

export interface PackageDiff {
  readonly files: readonly FileDiff[];
  /** Files that changed (added, removed or changed), the queue's "changed-file count". */
  readonly changedFiles: number;
  /** The patches stopped at {@link MAX_PATCH_LINES}: the rest of the files show their status only. */
  readonly truncated: boolean;
}

/** A text file larger than this is shown as changed without a line diff. */
export const MAX_TEXT_BYTES = 256 * 1024;
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

/** The file as text, or null when it is binary (a NUL, invalid UTF-8) or too large to diff. */
function textOf(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return "";
  if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
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
 * `after` against `before` (null: a new skill, every file added). Changed files come first, then
 * added, removed and unchanged ones, each by path.
 */
export function diffPackages(before: Uint8Array | null, after: Uint8Array): PackageDiff {
  const old = filesOf(before);
  const next = filesOf(after);
  const paths = [...new Set([...old.keys(), ...next.keys()])];
  const entries = paths
    .map((path) => ({ path, status: statusOf(old.get(path), next.get(path)) }))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.path < b.path ? -1 : 1));
  let budget = MAX_PATCH_LINES;
  let truncated = false;
  const files = entries.map(({ path, status }): FileDiff => {
    const a = old.get(path);
    const b = next.get(path);
    const size = (b ?? a)?.length ?? 0;
    const textA = textOf(a);
    const textB = textOf(b);
    const binary = textA === null || textB === null;
    if (binary || status === "unchanged" || budget <= 0) {
      if (!binary && status !== "unchanged" && budget <= 0) truncated = true;
      return { path, status, size, binary, hunks: [] };
    }
    const patch = structuredPatch(path, path, textA, textB, "", "", { context: CONTEXT_LINES });
    const hunks = patch.hunks.map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    }));
    budget -= hunks.reduce((n, h) => n + h.lines.length, 0);
    return { path, status, size, binary, hunks };
  });
  return {
    files,
    changedFiles: entries.filter((e) => e.status !== "unchanged").length,
    truncated,
  };
}
