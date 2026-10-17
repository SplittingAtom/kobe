import { lockLegalHolds, sql, type KobeTx } from "@kobe/db";
import { workspacePathIssue } from "@kobe/protocol";
import type { WorkspaceOwner } from "./keys.js";
import { movedRecently, recentRepeat, recordMove } from "./move-journal.js";
import { lockWorkspace, roomForRows, saveState } from "./store.js";

/**
 * A server-side move of a file or folder within one workspace's manifest (KOBE-304). The protocol
 * is manifest-first, in one transaction under the workspace lock:
 *
 * 1. every live row at `from` (a file) or under `from/` (a folder) gets a new row at the matching
 *    path under `to`, with the same content (`sha256`, object key, size, mtime, mode) and origin
 *    `server`; then the old rows become tombstones. Revisions: the new rows first, then the
 *    tombstones, so a sandbox pulling page by page never sees the file in neither place.
 * 2. The object store is not touched: objects are content-addressed and the new rows name the same
 *    keys, so nothing is copied, deleted or released (collection only frees content no live row
 *    references).
 *
 * 3. the move goes into the journal (`workspace_moves`). The sandbox agent replays journal moves
 *    newer than its last pull as local renames of the whole tree before it pulls the rows (an
 *    awake one is nudged with `workspace.moved` over its socket; a hibernated one replays on
 *    wake), so nothing is downloaded again and unsynced edits, caches and never-synced files move
 *    along. Without the journal entry (an old agent, a trimmed journal) the pull alone converges:
 *    the new path is downloaded, the old one removed if unchanged.
 *
 * A crash anywhere rolls the whole transaction back; there is no partial move to resume. A repeat
 * of a move that already happened (a retry after a lost answer) answers as that move did.
 *
 * Legal hold: the legal-hold lock is taken shared first (the same order as deletes and collection:
 * holds, then the workspace), and one INSERT copies each moved file's old path, content and
 * revision into `workspace_file_hold_history` filtered by `legal_hold_covers` in SQL, so the move
 * answers the same with or without a hold and the old path's link to its content is kept.
 */

export interface MoveRequest {
  readonly from: string;
  readonly to: string;
  /** Refuse a folder (a move into `uploads/` may only be a member's drop: one file). */
  readonly fileOnly: boolean;
  readonly maxFiles: number;
  /** Rows (live + tombstones) per workspace. */
  readonly maxRows: number;
  /**
   * Per-member budget on what moves may carry in a window, besides the count of moves (a move
   * starts only while the member's moves in the window are under both caps).
   */
  readonly budget: { readonly windowMs: number; readonly files: number; readonly bytes: number };
}

export type MoveOutcome =
  | {
      readonly kind: "moved";
      readonly type: "file" | "dir";
      readonly files: number;
      readonly bytes: number;
      /** A retry of a move already done (nothing changed now; not audited again). */
      readonly repeat?: true;
    }
  | {
      readonly kind:
        "missing" | "taken" | "too_many" | "too_long" | "folder" | "no_room" | "over_budget";
    };

const ESCAPE_LIKE = /[\\%_]/g;
const likeUnder = (folder: string) => `${folder.replace(ESCAPE_LIKE, (c) => `\\${c}`)}/%`;
/** Code points, as Postgres counts characters in a UTF-8 database. */
const chars = (s: string) => [...s].length;

/** Every proper ancestor folder of `path`: `a/b/c` -> `a`, `a/b`. */
function ancestorsOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

type SourceRow = { path: string; size: string };

/** The live rows the move takes: the file at `from`, else everything under `from/`. */
async function sources(
  tx: KobeTx,
  owner: WorkspaceOwner,
  from: string,
  limit: number,
): Promise<{ readonly type: "file" | "dir"; readonly rows: SourceRow[] }> {
  const file = await tx.execute<SourceRow>(sql`
    SELECT path, size FROM workspace_files
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted
       AND path = ${from}`);
  if (file.rows.length > 0) return { type: "file", rows: file.rows };
  const under = await tx.execute<SourceRow>(sql`
    SELECT path, size FROM workspace_files
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted
       AND path LIKE ${likeUnder(from)}
     ORDER BY path COLLATE "C" LIMIT ${limit + 1}`);
  return { type: "dir", rows: under.rows };
}

/**
 * Whether a live file sits at `to`, under it, or at one of its ancestors (it would clash), or a
 * sibling's name equals the new name once both are in Unicode NFC (`café` composed and decomposed
 * would show as one name twice). The source itself is never in the way.
 */
async function destinationTaken(
  tx: KobeTx,
  owner: WorkspaceOwner,
  from: string,
  to: string,
): Promise<boolean> {
  const ancestors = ancestorsOf(to);
  const res = await tx.execute(sql`
    SELECT 1 FROM workspace_files
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted
       AND (path = ${to} OR path LIKE ${likeUnder(to)}
            ${ancestors.length > 0 ? sql`OR path IN ${ancestors}` : sql``})
     LIMIT 1`);
  if (res.rows.length > 0) return true;
  const slash = to.lastIndexOf("/");
  const parent = slash < 0 ? "" : to.slice(0, slash);
  const name = to.slice(slash + 1);
  const skip = parent === "" ? 0 : chars(parent) + 1;
  const twin = await tx.execute(sql`
    SELECT 1 FROM workspace_files
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted
       ${parent === "" ? sql`` : sql`AND path LIKE ${likeUnder(parent)}`}
       AND path <> ${from} AND path NOT LIKE ${likeUnder(from)}
       AND normalize(split_part(substr(path, ${skip + 1}), '/', 1), NFC) = normalize(${name}, NFC)
     LIMIT 1`);
  return twin.rows.length > 0;
}

/** The SQL condition selecting the moved rows (alias-free; `workspace_files` columns). */
function sourceFilter(owner: WorkspaceOwner, from: string, type: "file" | "dir") {
  return sql`team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted
    AND ${type === "file" ? sql`path = ${from}` : sql`path LIKE ${likeUnder(from)}`}`;
}

/** Moves `from` to `to` in the caller's team transaction. The caller checks the path rules. */
export async function moveFiles(
  tx: KobeTx,
  owner: WorkspaceOwner,
  request: MoveRequest,
): Promise<MoveOutcome> {
  const { from, to } = request;
  await lockLegalHolds(tx);
  let state = await lockWorkspace(tx, owner);
  const { type, rows } = await sources(tx, owner, from, request.maxFiles);
  if (rows.length === 0) {
    const repeat = await recentRepeat(tx, owner, from, to);
    return repeat
      ? { kind: "moved", type: repeat.type, files: repeat.files, bytes: 0, repeat: true }
      : { kind: "missing" };
  }
  if (type === "dir" && request.fileOnly) return { kind: "folder" };
  if (rows.length > request.maxFiles) return { kind: "too_many" };
  const target = (path: string) => `${to}${path.slice(from.length)}`;
  if (rows.some((r) => workspacePathIssue(target(r.path)) !== undefined)) {
    return { kind: "too_long" };
  }
  if (await destinationTaken(tx, owner, from, to)) return { kind: "taken" };
  const used = await movedRecently(tx, owner, request.budget.windowMs);
  if (used.files >= request.budget.files || used.bytes >= request.budget.bytes) {
    return { kind: "over_budget" };
  }

  const room = await roomForRows(tx, owner, state, rows.length, request.maxRows);
  state = room.state;
  if (!room.ok) {
    await saveState(tx, owner, state, false); // keep what a compaction did
    return { kind: "no_room" };
  }
  const skip = chars(from);
  const filter = sourceFilter(owner, from, type);
  const newPath = sql`${to} || substr(path, ${skip + 1})`;

  // Kept for a hold, decided in SQL: the same statements run either way.
  await tx.execute(sql`
    INSERT INTO workspace_file_hold_history
      (team_id, user_id, path, moved_to, sha256, blob_key, size, mtime_ms, file_rev)
    SELECT team_id, user_id, path, ${newPath}, sha256, blob_key, size, mtime_ms, rev
      FROM workspace_files
     WHERE ${filter} AND public.legal_hold_covers(team_id, user_id)`);

  // Tombstones at the new paths (nothing live is there) are reused by the upsert.
  const reused = await tx.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM workspace_files d
     WHERE d.team_id = ${owner.teamId} AND d.user_id = ${owner.userId} AND d.deleted
       AND d.path IN (SELECT ${newPath} FROM workspace_files WHERE ${filter})`);
  const head = state.headRev;
  const moved = rows.length;
  const inserted = await tx.execute(sql`
    INSERT INTO workspace_files
      (team_id, user_id, path, rev, deleted, sha256, blob_key, size, mtime_ms, executable, origin,
       updated_at)
    SELECT team_id, user_id, ${newPath},
           ${head} + row_number() OVER (ORDER BY path COLLATE "C"),
           false, sha256, blob_key, size, mtime_ms, executable, 'server', now()
      FROM workspace_files
     WHERE ${filter}
    ON CONFLICT (team_id, user_id, path) DO UPDATE SET
      rev = EXCLUDED.rev, deleted = false, sha256 = EXCLUDED.sha256,
      blob_key = EXCLUDED.blob_key, size = EXCLUDED.size, mtime_ms = EXCLUDED.mtime_ms,
      executable = EXCLUDED.executable, origin = 'server', updated_at = now()
      WHERE workspace_files.deleted`);
  const tombstoned = await tx.execute(sql`
    UPDATE workspace_files f
       SET rev = s.rev, deleted = true, sha256 = NULL, blob_key = NULL, executable = false,
           origin = 'server', updated_at = now()
      FROM (SELECT path, ${head + moved} + row_number() OVER (ORDER BY path COLLATE "C") AS rev
              FROM workspace_files WHERE ${filter}) s
     WHERE f.team_id = ${owner.teamId} AND f.user_id = ${owner.userId} AND f.path = s.path`);
  if ((inserted.rowCount ?? 0) !== moved || (tombstoned.rowCount ?? 0) !== moved) {
    throw new Error("workspace move: the manifest changed under the workspace lock");
  }
  const reusedRows = Number(reused.rows[0]?.n ?? 0);
  await saveState(
    tx,
    owner,
    {
      ...state,
      headRev: head + 2 * moved,
      // Same files, same bytes: neither side is a project mount (countedBytes is the size).
      tombstones: state.tombstones + moved - reusedRows,
    },
    false,
  );
  const bytes = rows.reduce((sum, r) => sum + Number(r.size), 0);
  // The sandbox replays this as a local rename of the whole tree (KOBE-304).
  await recordMove(tx, owner, { rev: head + 1, from, to, type, files: moved, bytes });
  return { kind: "moved", type, files: moved, bytes };
}
