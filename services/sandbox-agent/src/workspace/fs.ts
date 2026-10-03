import { createHash, randomBytes } from "node:crypto";
import { constants as FS } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, rename, rm, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { isExcludedPath, isServerOwnedPath, workspacePathIssue } from "@kobe/protocol";

/**
 * Filesystem side of workspace sync (KOBE-27). Paths are workspace-relative POSIX paths (protocol
 * `workspacePathIssue` rules). Model-run code shares this uid and filesystem, so nothing here
 * follows a symlink out of the workspace: parents are checked component by component, writes go
 * to an exclusive temp file renamed into place, symlinks are never synced.
 */
export interface LocalFile {
  readonly size: number;
  /** Whole milliseconds. */
  readonly mtimeMs: number;
  readonly executable: boolean;
}

export interface ScanResult {
  readonly files: Map<string, LocalFile>;
  /** Directories that could not be read, or the scan stopped early: never infer deletions there. */
  readonly incomplete: readonly string[];
  readonly truncated: boolean;
}

/** Temp files of an interrupted download: never synced. */
export const TEMP_PREFIX = ".kobe-sync-";

export function toLocal(stat: { size: number; mtimeMs: number; mode: number }): LocalFile {
  return {
    size: stat.size,
    // Rounded: an mtime set from whole milliseconds may read back a hair below them.
    mtimeMs: Math.round(stat.mtimeMs),
    executable: (stat.mode & 0o100) !== 0,
  };
}

/**
 * Regular files under `root`, skipping excluded areas (`.kobe/`), directories named in
 * `skipDirs` (anywhere), symlinks, special files and temp files. Stops after `maxFiles`.
 */
export async function scanWorkspace(
  root: string,
  options: { readonly skipDirs: ReadonlySet<string>; readonly maxFiles: number },
): Promise<ScanResult> {
  const files = new Map<string, LocalFile>();
  const incomplete: string[] = [];
  let truncated = false;
  const walk = async (rel: string): Promise<void> => {
    let dir;
    try {
      dir = await opendir(rel === "" ? root : path.join(root, rel));
    } catch {
      incomplete.push(rel);
      return;
    }
    for await (const entry of dir) {
      if (truncated) return;
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (isExcludedPath(child) || entry.name.startsWith(TEMP_PREFIX)) continue;
      if (workspacePathIssue(child) !== undefined) continue;
      if (entry.isDirectory()) {
        if (options.skipDirs.has(entry.name)) continue;
        await walk(child);
      } else if (entry.isFile()) {
        try {
          const stat = await lstat(path.join(root, child));
          if (!stat.isFile()) continue;
          files.set(child, toLocal(stat));
        } catch {
          continue; // vanished meanwhile
        }
        if (files.size >= options.maxFiles) {
          truncated = true;
          return;
        }
      }
    }
  };
  await walk("");
  return { files, incomplete, truncated };
}

/** The file's current state, or undefined when it is missing or not a regular file. */
export async function statLocal(root: string, rel: string): Promise<LocalFile | undefined> {
  try {
    const stat = await lstat(path.join(root, rel));
    return stat.isFile() ? toLocal(stat) : undefined;
  } catch {
    return undefined;
  }
}

/** SHA-256 and byte count of a file, read without following a final symlink. */
export async function hashFile(
  root: string,
  rel: string,
): Promise<{ sha256: string; size: number } | undefined> {
  const hash = createHash("sha256");
  let size = 0;
  try {
    const handle = await open(path.join(root, rel), FS.O_RDONLY | FS.O_NOFOLLOW);
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk as Buffer);
        size += (chunk as Buffer).length;
      }
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  return { sha256: hash.digest("hex"), size };
}

/** A read stream of the file, opened without following a final symlink (closed at its end). */
export async function openForUpload(root: string, rel: string): Promise<Readable> {
  const handle = await open(path.join(root, rel), FS.O_RDONLY | FS.O_NOFOLLOW);
  return handle.createReadStream();
}

/**
 * Makes every parent directory of `rel` a real directory inside `root`. In server-owned areas a
 * symlink or file in the way is removed (those areas mirror the server); elsewhere it is an
 * error (the sandbox's own data is never removed to make room). Directories in server-owned
 * areas are made writable for the agent (they are re-locked by {@link lockServerOwned}).
 */
export async function ensureParents(root: string, rel: string): Promise<void> {
  const parts = rel.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current === "" ? part : `${current}/${part}`;
    const abs = path.join(root, current);
    const owned = isServerOwnedPath(`${current}/`);
    let stat;
    try {
      stat = await lstat(abs);
    } catch {
      // Parallel downloads may create the same directory: EEXIST is fine if it is one.
      await mkdir(abs, { mode: 0o755 }).catch(async (error: unknown) => {
        if (!(await lstat(abs).catch(() => undefined))?.isDirectory()) throw error;
      });
      continue;
    }
    if (stat.isDirectory()) {
      if (owned && (stat.mode & 0o200) === 0) await chmod(abs, 0o755);
      continue;
    }
    if (!owned) throw new Error(`a file or link is in the way of directory ${current}`);
    await rm(abs, { force: true });
    await mkdir(abs, { mode: 0o755 });
  }
}

export class ContentMismatchError extends Error {
  constructor() {
    super("downloaded bytes do not match the manifest");
    this.name = "ContentMismatchError";
  }
}

/**
 * Writes `body` to `rel` atomically: an exclusive, unpredictable temp file next to it (never
 * through a symlink), verified against `sha256`/`size`, mode and mtime set, then renamed over the
 * target (a rename replaces a symlink itself, never its target).
 */
export async function writeFileAtomic(
  root: string,
  rel: string,
  body: Readable,
  expect: {
    readonly sha256: string;
    readonly size: number;
    readonly mtimeMs: number;
    readonly mode: number;
  },
): Promise<void> {
  await ensureParents(root, rel);
  const target = path.join(root, rel);
  const temp = path.join(path.dirname(target), `${TEMP_PREFIX}${randomBytes(12).toString("hex")}`);
  const handle = await open(temp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    const counter = new Transform({
      transform(chunk: Buffer, _e, done) {
        hash.update(chunk);
        size += chunk.length;
        done(null, chunk);
      },
    });
    // The write stream closes the handle when it finishes (or fails).
    await pipeline(body, counter, handle.createWriteStream());
    if (size !== expect.size || hash.digest("hex") !== expect.sha256)
      throw new ContentMismatchError();
    await chmod(temp, expect.mode);
    const seconds = expect.mtimeMs / 1000;
    await utimes(temp, seconds, seconds);
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isDirectory()) throw new Error(`a directory is in the way of ${rel}`);
    await rename(temp, target);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** Removes a file (never a directory); missing is fine. Empty parents are left in place. */
export async function removeFile(root: string, rel: string): Promise<void> {
  const abs = path.join(root, rel);
  const stat = await lstat(abs).catch(() => undefined);
  if (!stat || stat.isDirectory()) return;
  if (isServerOwnedPath(rel)) await ensureParents(root, rel);
  await unlink(abs).catch(() => {});
}

/** `dir/name.ext` → `dir/name.conflict-20261003T120000Z.ext` (a free name). */
export async function conflictCopyName(root: string, rel: string, now: Date): Promise<string> {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  for (let i = 0; ; i++) {
    const name = `${stem}.conflict-${stamp}${i === 0 ? "" : `-${i}`}${ext}`;
    const candidate = dir === "." ? name : `${dir}/${name}`;
    if ((await lstat(path.join(root, candidate)).catch(() => undefined)) === undefined) {
      return candidate;
    }
  }
}

export async function renameWithin(root: string, from: string, to: string): Promise<void> {
  await rename(path.join(root, from), path.join(root, to));
}

/**
 * Server-owned areas are read-only to the agent: files 0444, directories 0555. (Same uid, so this
 * is a speed bump; the guarantee is that the server never accepts writes there and the agent
 * reverts local changes on its next sync.)
 */
export async function lockServerOwned(root: string, areas: readonly string[]): Promise<void> {
  const lock = async (rel: string): Promise<void> => {
    let dir;
    try {
      dir = await opendir(path.join(root, rel));
    } catch {
      return;
    }
    for await (const entry of dir) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await lock(child);
      else if (entry.isFile()) await chmod(path.join(root, child), 0o444).catch(() => {});
    }
    await chmod(path.join(root, rel), 0o555).catch(() => {});
  };
  for (const area of areas) await lock(area.replace(/\/$/, ""));
}
