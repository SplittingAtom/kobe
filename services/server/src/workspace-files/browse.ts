import { sql, type KobeTx } from "@kobe/db";
import type { WorkspaceFileEntry } from "@kobe/protocol";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import type { StoredEntry } from "../workspace-sync/store.js";
import { areaOf, baseName, underPattern } from "./paths.js";

/** Entries one folder listing returns at most (the contract has no cursor; see the ledger). */
export const LIST_MAX_ENTRIES = 5000;

type ChildRow = {
  name: string;
  is_dir: boolean;
  size: string;
  mtime_ms: string;
  sha256: string | null;
};

export interface FolderListing {
  readonly entries: WorkspaceFileEntry[];
  readonly truncated: boolean;
}

/**
 * The immediate children of `folder` in the user's last synced manifest (live rows only), folders
 * first. Folders are implied by deeper paths: their mtime is the newest below. One grouped query
 * over the path prefix; rows come from the caller's own (team, user) only.
 */
export async function listFolder(
  tx: KobeTx,
  owner: WorkspaceOwner,
  folder: string,
): Promise<FolderListing> {
  const skip = folder === "" ? 0 : [...folder].length + 1;
  const res = await tx.execute<ChildRow>(sql`
    SELECT name, bool_or(deeper) AS is_dir, max(size) AS size, max(mtime_ms) AS mtime_ms,
           max(sha256) AS sha256
      FROM (
        SELECT split_part(rest, '/', 1) AS name, position('/' IN rest) > 0 AS deeper,
               size, mtime_ms, sha256
          FROM (
            SELECT substr(path, ${skip + 1}) AS rest, size, mtime_ms, sha256
              FROM workspace_files
             WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted
               AND path LIKE ${underPattern(folder)}
          ) AS under
      ) AS children
     GROUP BY name
     ORDER BY bool_or(deeper) DESC, name COLLATE "C"
     LIMIT ${LIST_MAX_ENTRIES + 1}`);
  const rows = res.rows.slice(0, LIST_MAX_ENTRIES);
  return {
    entries: rows.map((r) => childEntry(folder, r)),
    truncated: res.rows.length > LIST_MAX_ENTRIES,
  };
}

function childEntry(folder: string, r: ChildRow): WorkspaceFileEntry {
  const path = folder === "" ? r.name : `${folder}/${r.name}`;
  const area = areaOf(path);
  const base = {
    name: r.name,
    path,
    mtime: new Date(Number(r.mtime_ms)).toISOString().replace(/\.\d+Z$/, "Z"),
    source: "synced" as const,
    owner: area === "workspace" ? ("sandbox" as const) : ("server" as const),
    area,
  };
  if (r.is_dir) return { ...base, type: "dir", size_bytes: null };
  return {
    ...base,
    type: "file",
    size_bytes: Number(r.size),
    ...(r.sha256 === null ? {} : { sha256: r.sha256 }),
  };
}

/** The contract row of one stored file (after an upload). */
export function fileEntry(e: StoredEntry): WorkspaceFileEntry {
  const area = areaOf(e.path);
  return {
    name: baseName(e.path),
    path: e.path,
    type: "file",
    size_bytes: e.size,
    mtime: new Date(e.mtime_ms).toISOString().replace(/\.\d+Z$/, "Z"),
    source: "synced",
    owner: area === "workspace" ? "sandbox" : "server",
    area,
    ...(e.sha256 === undefined ? {} : { sha256: e.sha256 }),
  };
}

export interface FolderFile {
  readonly path: string;
  readonly size: number;
}

/** Live files at or under `path` (the file itself, or a folder's files), at most `limit`. */
export async function liveFilesUnder(
  tx: KobeTx,
  owner: WorkspaceOwner,
  path: string,
  limit: number,
): Promise<FolderFile[]> {
  const res = await tx.execute<{ path: string; size: string }>(sql`
    SELECT path, size FROM workspace_files
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted
       AND (path = ${path} OR path LIKE ${underPattern(path)})
     ORDER BY path COLLATE "C" LIMIT ${limit}`);
  return res.rows.map((r) => ({ path: r.path, size: Number(r.size) }));
}

/** Whether a live file sits at `path`, under it, or at one of `ancestors` (an upload would clash). */
export async function pathIsTaken(
  tx: KobeTx,
  owner: WorkspaceOwner,
  path: string,
  ancestors: readonly string[],
): Promise<boolean> {
  const anc = ancestors.length > 0 ? sql`OR path IN ${[...ancestors]}` : sql``;
  const res = await tx.execute(sql`
    SELECT 1 FROM workspace_files
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted
       AND (path = ${path} OR path LIKE ${underPattern(path)} ${anc})
     LIMIT 1`);
  return res.rows.length > 0;
}
