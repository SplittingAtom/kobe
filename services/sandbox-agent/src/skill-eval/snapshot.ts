import { constants as FS, existsSync, type Stats } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import {
  EVAL_WORKSPACE_MAX_FILES,
  SANDBOX_MAX_FRAME_BYTES,
  isReservedWorkspacePath,
  type EvalWorkspaceEntry,
  type EvalWorkspaceSnapshot,
  type EvalWorkspaceWalk,
} from "@kobe/protocol";
import { hashFile } from "../workspace/fs.js";

// The after-snapshot of a skill eval's workspace (KOBE-325, contract KOBE-324 `outputs.ts`):
// one walk per literal root, `lstat` only, never following a symbolic link (a linked root, parent
// or entry is recorded, never entered or read), regular files only, nothing below a `skills` or
// hidden segment, at most EVAL_WORKSPACE_MAX_FILES entries per walk, SHA-256 only for the fixture
// paths the server names (a large output is never hashed).

const typeOf = (s: { isFile(): boolean; isSymbolicLink(): boolean }): EvalWorkspaceEntry["type"] =>
  s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : "other";

/** The root's own path (`outputs/` → `outputs`), checked segment by segment without following. */
async function rootEntry(
  workspace: string,
  root: string,
): Promise<{ kind: "dir"; rel: string } | { kind: "stop"; entries: EvalWorkspaceEntry[] }> {
  const rel = root.endsWith("/") ? root.slice(0, -1) : root;
  if (rel === "") return { kind: "dir", rel };
  if (isReservedWorkspacePath(rel)) return { kind: "stop", entries: [] };
  let current = "";
  for (const part of rel.split("/")) {
    current = current === "" ? part : `${current}/${part}`;
    const stat = await lstat(path.join(workspace, current)).catch(() => undefined);
    if (!stat) return { kind: "stop", entries: [] };
    if (stat.isDirectory()) continue;
    // A link (or a file) where the root or a parent should be: recorded, never entered.
    return { kind: "stop", entries: [{ path: current, type: typeOf(stat), size: stat.size }] };
  }
  return { kind: "dir", rel };
}

/** Directories one walk may visit (review L3): a deep tree of empty folders is cut off too. */
export const EVAL_WALK_MAX_DIRS = 10_000;
/**
 * The snapshot's size budget, well under the wire's frame limit (`SANDBOX_MAX_FRAME_BYTES`, the
 * `command.result` that carries it): a walk that would pass it ends truncated.
 */
export const EVAL_SNAPSHOT_MAX_BYTES = Math.floor(SANDBOX_MAX_FRAME_BYTES * 0.75);

const PROC_FD = existsSync("/proc/self/fd") ? "/proc/self/fd" : undefined;

/**
 * One directory's entries (name and lstat), read without following a link anywhere (review L3):
 * the directory is opened `O_NOFOLLOW | O_DIRECTORY`; on Linux its open file must be at exactly
 * `workspace/rel` (so no parent on the way was a link) and it is read through its descriptor, so
 * a parent swapped for a link afterwards changes nothing; elsewhere (tests) the path must still
 * name the same directory after the read. Null when the directory is not safe to read.
 */
async function listDir(
  workspace: string,
  rel: string,
): Promise<{ name: string; stat: Stats }[] | null> {
  const abs = rel === "" ? workspace : path.join(workspace, rel);
  let handle;
  try {
    handle = await open(abs, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const opened = await handle.stat();
    let base = abs;
    if (PROC_FD) {
      base = `${PROC_FD}/${handle.fd}`;
      if ((await readlink(base)) !== abs) return null;
    }
    const out: { name: string; stat: Stats }[] = [];
    for (const name of (await readdir(base)).sort()) {
      const stat = await lstat(`${base}/${name}`).catch(() => undefined);
      if (stat) out.push({ name, stat });
    }
    if (!PROC_FD) {
      const again = await lstat(abs).catch(() => undefined);
      if (!again || again.ino !== opened.ino || again.dev !== opened.dev) return null;
    }
    return out;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** A rough size of an entry as JSON (the budget never under-counts by much). */
const entryBytes = (e: EvalWorkspaceEntry) => Buffer.byteLength(JSON.stringify(e)) + 1;

async function walkOne(
  workspace: string,
  root: string,
  hashPaths: ReadonlySet<string>,
  budget: { bytes: number },
): Promise<EvalWorkspaceWalk> {
  const start = await rootEntry(workspace, root);
  if (start.kind === "stop") return { root, entries: start.entries, truncated: false };
  const entries: EvalWorkspaceEntry[] = [];
  const pending: string[] = [start.rel];
  let dirs = 0;
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    dirs += 1;
    if (dirs > EVAL_WALK_MAX_DIRS) return { root, entries, truncated: true };
    const listed = await listDir(workspace, dir);
    // A directory that changed under the walk (a link swapped in) is never trusted.
    if (listed === null) return { root, entries, truncated: true };
    for (const { name, stat } of listed) {
      const rel = dir === "" ? name : `${dir}/${name}`;
      if (isReservedWorkspacePath(rel)) continue;
      if (stat.isDirectory()) {
        pending.push(rel);
        continue;
      }
      if (entries.length >= EVAL_WORKSPACE_MAX_FILES) return { root, entries, truncated: true };
      let entry: EvalWorkspaceEntry = { path: rel, type: typeOf(stat), size: stat.size };
      if (entry.type === "file" && hashPaths.has(rel)) {
        const hashed = await hashFile(workspace, rel);
        if (hashed) entry = { ...entry, size: hashed.size, sha256: hashed.sha256 };
      }
      budget.bytes -= entryBytes(entry);
      if (budget.bytes < 0) return { root, entries, truncated: true };
      entries.push(entry);
    }
  }
  return { root, entries, truncated: false };
}

export async function snapshotWorkspace(
  workspace: string,
  roots: readonly string[],
  hashPaths: readonly string[],
): Promise<EvalWorkspaceSnapshot> {
  const hashes = new Set(hashPaths);
  const walks: EvalWorkspaceWalk[] = [];
  const budget = { bytes: EVAL_SNAPSHOT_MAX_BYTES };
  // The descriptor check compares real paths: a trailing slash or `..` must not fail every walk.
  const resolved = path.resolve(workspace);
  for (const root of roots) walks.push(await walkOne(resolved, root, hashes, budget));
  return { walks };
}
