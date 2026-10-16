import { sql, type KobeTx } from "@kobe/db";
import {
  mentionPathIssue,
  WORKSPACE_EXCLUDED_PREFIXES,
  WORKSPACE_SEARCH_MAX_RESULTS,
  type WorkspaceFileEntry,
} from "@kobe/protocol";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import { areaOf, baseName, underPattern } from "./paths.js";

type SearchRow = { path: string; size: string; mtime_ms: string; sha256: string | null };

const INTERNAL = WORKSPACE_EXCLUDED_PREFIXES.map((p) => underPattern(p.slice(0, -1)));

/**
 * Rows one search reads at most, tombstones included, in path order through the primary key
 * (team, user, path): the work per call is bounded however many rows a workspace holds; files
 * past the bound are not found (KOBE-223 S1).
 */
export const SEARCH_SCAN_MAX = 20_000;
/** Matches taken from the scan, before ranking. */
const SEARCH_MATCH_MAX = 500;

/**
 * The caller's own synced files whose path contains `query` (case-insensitive), for the composer's
 * `@` picker (KOBE-223). Files only (manifest rows are files; symlinks are never synced), live
 * rows only, agent-internal paths never, and never a path that cannot be mentioned
 * (`mentionPathIssue`: invisible, format or shell characters). Reads at most
 * {@link SEARCH_SCAN_MAX} rows by index and no per-row regex; names starting with the query come
 * first, then newest. Rows come from the owner's (team, user) only; the caller runs it inside
 * `withTeam()`.
 */
export async function searchFiles(
  tx: KobeTx,
  owner: WorkspaceOwner,
  query: string,
  limit: number = WORKSPACE_SEARCH_MAX_RESULTS,
  scanMax: number = SEARCH_SCAN_MAX,
): Promise<WorkspaceFileEntry[]> {
  const q = query.toLowerCase();
  const internal = INTERNAL.map((pattern) => sql`AND path NOT LIKE ${pattern}`);
  const res = await tx.execute<SearchRow>(sql`
    SELECT path, size, mtime_ms, sha256 FROM (
      SELECT path, size, mtime_ms, sha256, deleted FROM workspace_files
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
       ORDER BY path LIMIT ${scanMax}
    ) AS scanned
     WHERE NOT deleted AND strpos(lower(path), ${q}) > 0 ${sql.join(internal, sql` `)}
     LIMIT ${SEARCH_MATCH_MAX}`);
  const cap = Math.min(Math.max(limit, 1), WORKSPACE_SEARCH_MAX_RESULTS);
  const startsWith = (r: SearchRow) => baseName(r.path).toLowerCase().startsWith(q);
  return res.rows
    .filter((r) => mentionPathIssue(r.path) === undefined)
    .sort(
      (a, b) =>
        Number(startsWith(b)) - Number(startsWith(a)) ||
        Number(b.mtime_ms) - Number(a.mtime_ms) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    .slice(0, cap)
    .map(searchEntry);
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
