import { sql, type KobeTx } from "@kobe/db";
import type { WorkspaceFileEntry } from "@kobe/protocol";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import type { StoredEntry } from "../workspace-sync/store.js";
import { areaOf, baseName, underPattern } from "./paths.js";

/** Entries one page of a folder listing holds at most (more follow through `next_cursor`). */
export const LIST_MAX_ENTRIES = 5000;

/** A position in the listing order (folders first, then name): the last entry of the previous page. */
export interface ListPosition {
  readonly dir: boolean;
  readonly name: string;
}

/** Opaque cursor: base64url JSON of the last entry's position. Not signed; it only names a position in the caller's own listing. */
export function encodeCursor(position: ListPosition): string {
  return Buffer.from(JSON.stringify({ d: position.dir ? 1 : 0, n: position.name })).toString(
    "base64url",
  );
}

/** The position a cursor names, or undefined when it is not one this server issues. */
export function decodeCursor(cursor: string): ListPosition | undefined {
  try {
    const raw: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const { d, n } = raw as { d?: unknown; n?: unknown };
    if ((d !== 0 && d !== 1) || typeof n !== "string" || n === "" || n.length > 255) {
      return undefined;
    }
    return { dir: d === 1, name: n };
  } catch {
    return undefined;
  }
}

type ChildRow = {
  name: string;
  is_dir: boolean;
  size: string;
  mtime_ms: string;
  sha256: string | null;
};

export interface FolderListing {
  readonly entries: WorkspaceFileEntry[];
  /** Present when more entries follow: the `cursor` of the next page. */
  readonly nextCursor: string | undefined;
}

export interface ListOptions {
  readonly limit?: number;
  readonly after?: ListPosition;
}

/**
 * The immediate children of `folder` in the user's last synced manifest (live rows only), folders
 * first. Folders are implied by deeper paths: their mtime is the newest below. One grouped query
 * over the path prefix; rows come from the caller's own (team, user) only. Pages are keyset
 * pages on (folder?, name): `after` skips everything up to and including that position.
 */
export async function listFolder(
  tx: KobeTx,
  owner: WorkspaceOwner,
  folder: string,
  options: ListOptions = {},
): Promise<FolderListing> {
  const limit = options.limit ?? LIST_MAX_ENTRIES;
  const { after } = options;
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
     ${
       after
         ? sql`HAVING (${after.dir}::boolean AND NOT bool_or(deeper))
                   OR (bool_or(deeper) = ${after.dir}::boolean
                       AND name COLLATE "C" > ${after.name} COLLATE "C")`
         : sql``
     }
     ORDER BY bool_or(deeper) DESC, name COLLATE "C"
     LIMIT ${limit + 1}`);
  const page = res.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    entries: page.map((r) => childEntry(folder, r)),
    nextCursor:
      res.rows.length > limit && last
        ? encodeCursor({ dir: last.is_dir, name: last.name })
        : undefined,
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
