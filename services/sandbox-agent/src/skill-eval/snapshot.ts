import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  EVAL_WORKSPACE_MAX_FILES,
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

async function walkOne(
  workspace: string,
  root: string,
  hashPaths: ReadonlySet<string>,
): Promise<EvalWorkspaceWalk> {
  const start = await rootEntry(workspace, root);
  if (start.kind === "stop") return { root, entries: start.entries, truncated: false };
  const entries: EvalWorkspaceEntry[] = [];
  const pending: string[] = [start.rel];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    const names = await readdir(path.join(workspace, dir)).catch(() => [] as string[]);
    for (const name of names.sort()) {
      const rel = dir === "" ? name : `${dir}/${name}`;
      if (isReservedWorkspacePath(rel)) continue;
      const stat = await lstat(path.join(workspace, rel)).catch(() => undefined);
      if (!stat) continue;
      if (stat.isDirectory()) {
        pending.push(rel);
        continue;
      }
      if (entries.length >= EVAL_WORKSPACE_MAX_FILES) return { root, entries, truncated: true };
      const entry: EvalWorkspaceEntry = { path: rel, type: typeOf(stat), size: stat.size };
      if (entry.type === "file" && hashPaths.has(rel)) {
        const hashed = await hashFile(workspace, rel);
        entries.push(hashed ? { ...entry, size: hashed.size, sha256: hashed.sha256 } : entry);
      } else entries.push(entry);
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
  for (const root of roots) walks.push(await walkOne(workspace, root, hashes));
  return { walks };
}
