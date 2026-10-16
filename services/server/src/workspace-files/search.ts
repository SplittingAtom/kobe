import { sql, type KobeTx } from "@kobe/db";
import {
  WORKSPACE_EXCLUDED_PREFIXES,
  WORKSPACE_SEARCH_MAX_RESULTS,
  type WorkspaceFileEntry,
} from "@kobe/protocol";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import { areaOf, baseName, underPattern } from "./paths.js";

type SearchRow = { path: string; size: string; mtime_ms: string; sha256: string | null };

const INTERNAL = WORKSPACE_EXCLUDED_PREFIXES.map((p) => underPattern(p.slice(0, -1)));

/**
 * The caller's own synced files whose path contains `query` (case-insensitive), for the composer's
 * `@` picker (KOBE-223). Files only (manifest rows are files; symlinks are never synced), live
 * rows only, agent-internal paths never. Names starting with the query come first, then newest.
 * Rows come from the owner's (team, user) only; the caller runs it inside `withTeam()`.
 */
export async function searchFiles(
  tx: KobeTx,
  owner: WorkspaceOwner,
  query: string,
  limit: number = WORKSPACE_SEARCH_MAX_RESULTS,
): Promise<WorkspaceFileEntry[]> {
  const q = query.toLowerCase();
  const internal = INTERNAL.map((pattern) => sql`AND path NOT LIKE ${pattern}`);
  const res = await tx.execute<SearchRow>(sql`
    SELECT path, size, mtime_ms, sha256 FROM workspace_files
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted
       ${sql.join(internal, sql` `)}
       AND strpos(lower(path), ${q}) > 0
     ORDER BY starts_with(lower(regexp_replace(path, '^.*/', '')), ${q}) DESC,
              mtime_ms DESC, path COLLATE "C"
     LIMIT ${Math.min(Math.max(limit, 1), WORKSPACE_SEARCH_MAX_RESULTS)}`);
  return res.rows.map(searchEntry);
}

function searchEntry(r: SearchRow): WorkspaceFileEntry {
  const area = areaOf(r.path);
  return {
    name: baseName(r.path),
    path: r.path,
    type: "file",
    size_bytes: Number(r.size),
    mtime: new Date(Number(r.mtime_ms)).toISOString().replace(/\.\d+Z$/, "Z"),
    source: "synced",
    owner: area === "workspace" ? "sandbox" : "server",
    area,
    ...(r.sha256 === null ? {} : { sha256: r.sha256 }),
  };
}

/** Of `paths`, the ones that are live files in the owner's synced workspace. */
export async function liveFilePaths(
  tx: KobeTx,
  owner: WorkspaceOwner,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  if (paths.length === 0) return new Set();
  const res = await tx.execute<{ path: string }>(sql`
    SELECT path FROM workspace_files
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted
       AND path IN ${[...new Set(paths)]}`);
  return new Set(res.rows.map((r) => r.path));
}
