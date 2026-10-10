import { createHash, randomBytes } from "node:crypto";
import { constants as FS } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  WORKSPACE_SEGMENT_MAX_BYTES,
  isExcludedPath,
  isServerOwnedPath,
  workspacePathIssue,
} from "@kobe/protocol";
import { assertOnVolume, openOnVolume, shareOnVolume } from "./volume.js";

/**
 * Filesystem side of workspace sync (KOBE-27). Paths are workspace-relative POSIX paths (protocol
 * `workspacePathIssue` rules). Model-run code can change this filesystem under the agent, so
 * nothing here follows a symlink out of the workspace: parents are checked component by component,
 * every file is opened and checked to be on the workspace volume (volume.ts), writes go to an
 * exclusive temp file renamed into place, symlinks are never synced. Files and directories are
 * group-writable (0664/0775): under Pi identities (KOBE-71) every thread's tools reach the shared
 * workspace through its group (D13).
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

/**
 * Whether every parent of `rel` is a real directory (no symlink on the way): reads, removals and
 * uploads never act on something outside the workspace through a linked parent.
 *
 * Accepted scope (TOCTOU): model-run code can swap a parent for a link between this check and the
 * following open/unlink/rename (every thread's tools can rename in the shared workspace). Under Pi
 * identities (KOBE-71) the agent can reach files those tools cannot (other Pis' runtime
 * directories, the bootstrap token), so every file the agent reads or writes is opened first and
 * checked to be on the workspace volume (workspace/volume.ts); this check protects against
 * accidents (a link left in the workspace). Writes are additionally `O_EXCL | O_NOFOLLOW` (see
 * `writeFileAtomic`). What stays possible through a swapped parent is removing, renaming or
 * chmod-ing an entry elsewhere that the agent owns, by name: a denial of service against the
 * user's own other threads (their runtime dirs fail the tripwire), never a read or a write.
 */
export async function parentsAreDirs(root: string, rel: string): Promise<boolean> {
  const parts = rel.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(() => undefined);
    if (!stat?.isDirectory()) return false;
  }
  return true;
}

/** The file's current state, or undefined when it is missing or not a regular file. */
export async function statLocal(root: string, rel: string): Promise<LocalFile | undefined> {
  if (!(await parentsAreDirs(root, rel))) return undefined;
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
  if (!(await parentsAreDirs(root, rel))) return undefined;
  const hash = createHash("sha256");
  let size = 0;
  try {
    const handle = await open(path.join(root, rel), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    try {
      await assertOnVolume(handle, root, rel);
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
  if (!(await parentsAreDirs(root, rel))) throw new Error("a parent directory is a link");
  const handle = await openOnVolume(root, path.join(root, rel), FS.O_RDONLY | FS.O_NONBLOCK);
  return handle.createReadStream();
}

/** Owner-only write: the Pi and tool uids hold the workspace group but are not the owner (KOBE-162). */
const OWNED_DIR_MODE = 0o755;

/**
 * A top-level server-owned folder (`projects`, `uploads`) that is not the agent's own was put there
 * by sandbox code (the workspace root is group-writable, so a tool can rename the real folder and
 * make its own). It is moved to `<name>.replaced-<random>` (a sandbox-owned path, kept and synced
 * as the user's data) so the real folder is rebuilt by the next sync. Without a uid (Windows) or
 * when running as root nothing can be told apart.
 */
async function reclaimAreaRoot(root: string, name: string): Promise<void> {
  const agentUid = process.getuid?.();
  const stat = await lstat(path.join(root, name)).catch(() => undefined);
  if (agentUid === undefined || agentUid === 0 || stat === undefined) return;
  if (stat.isDirectory() && stat.uid === agentUid) return;
  const aside = `${name}.replaced-${randomBytes(6).toString("hex")}`;
  await rename(path.join(root, name), path.join(root, aside));
}

/**
 * Makes every parent directory of `rel` a real directory inside `root`. In server-owned areas a
 * symlink or file in the way is removed (those areas mirror the server); elsewhere it is an
 * error (the sandbox's own data is never removed to make room). Directories in server-owned
 * areas are owner-writable only, always (a group bit would let a tool write into a project
 * folder while it is being filled); they are locked read-only by {@link lockServerOwned}.
 */
export async function ensureParents(root: string, rel: string): Promise<void> {
  const parts = rel.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current === "" ? part : `${current}/${part}`;
    const abs = path.join(root, current);
    const owned = isServerOwnedPath(`${current}/`);
    if (owned && !current.includes("/")) await reclaimAreaRoot(root, current);
    const dirMode = owned ? OWNED_DIR_MODE : 0o775;
    let stat;
    try {
      stat = await lstat(abs);
    } catch {
      // Parallel downloads may create the same directory: EEXIST is fine if it is one.
      await mkdir(abs, { mode: dirMode }).catch(async (error: unknown) => {
        if (!(await lstat(abs).catch(() => undefined))?.isDirectory()) throw error;
      });
      // The agent's umask is 077: every thread shares the workspace through its group.
      await shareOnVolume(root, abs, dirMode);
      continue;
    }
    if (stat.isDirectory()) {
      if (owned && (stat.mode & 0o7777 & ~0o2000) !== OWNED_DIR_MODE)
        await chmod(abs, OWNED_DIR_MODE);
      continue;
    }
    if (!owned) throw new Error(`a file or link is in the way of directory ${current}`);
    await rm(abs, { force: true });
    await mkdir(abs, { mode: dirMode });
    await shareOnVolume(root, abs, dirMode);
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
    // Written, chmod-ed and timed through the handle, and only on the workspace volume: a
    // replaced parent never makes the agent write elsewhere (workspace/volume.ts).
    await assertOnVolume(handle, root, temp);
    for await (const piece of body) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
      hash.update(chunk);
      size += chunk.length;
      for (let offset = 0; offset < chunk.length;) {
        offset += (await handle.write(chunk, offset)).bytesWritten;
      }
    }
    if (size !== expect.size || hash.digest("hex") !== expect.sha256)
      throw new ContentMismatchError();
    await handle.chmod(expect.mode);
    const seconds = expect.mtimeMs / 1000;
    await handle.utimes(seconds, seconds);
    await handle.close();
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
  if (!(await parentsAreDirs(root, rel))) return;
  const abs = path.join(root, rel);
  const stat = await lstat(abs).catch(() => undefined);
  if (!stat || stat.isDirectory()) return;
  if (isServerOwnedPath(rel)) await ensureParents(root, rel);
  await unlink(abs).catch(() => {});
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** The longest prefix of `s` within `max` UTF-8 bytes, never splitting a character. */
export function truncateUtf8(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (utf8Bytes(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/** `dir/name.ext` → `dir/name.conflict-20261003T120000Z.ext` (a free name, ≤ 255 bytes). */
export async function conflictCopyName(root: string, rel: string, now: Date): Promise<string> {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const dot = base.lastIndexOf(".");
  const [fullStem, fullExt] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  // The name must stay a valid segment (≤ 255 bytes): shorten the extension, then the stem.
  const ext = truncateUtf8(fullExt, 32);
  const stem = truncateUtf8(fullStem, WORKSPACE_SEGMENT_MAX_BYTES - 64 - utf8Bytes(ext));
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

/** Renames inside the workspace; refuses when either side's parents go through a link. */
export async function renameWithin(root: string, from: string, to: string): Promise<void> {
  if (!(await parentsAreDirs(root, from)) || !(await parentsAreDirs(root, to))) {
    throw new Error("a parent directory is a link");
  }
  await rename(path.join(root, from), path.join(root, to));
}

/**
 * Server-owned areas are read-only to the agent's tools: files 0444, directories 0555, all owned
 * by the agent's uid (KOBE-162). Under Pi identities (KOBE-71) the Pi and its tools run as other
 * uids that only hold the workspace group, so these modes are a real barrier: no write, create,
 * delete, rename or chmod in the area. Without identities (development) the tools share the
 * agent's uid and this is a speed bump; either way the server never accepts writes there and the
 * agent reverts local changes on its next sync.
 */
export async function lockServerOwned(root: string, areas: readonly string[]): Promise<void> {
  // Directory entries never follow links; the area roots are checked the same way (a symlinked
  // `uploads` would otherwise chmod whatever it points at).
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
  for (const area of areas) {
    const rel = area.replace(/\/$/, "");
    const stat = await lstat(path.join(root, rel)).catch(() => undefined);
    if (stat?.isDirectory()) await lock(rel);
  }
}
