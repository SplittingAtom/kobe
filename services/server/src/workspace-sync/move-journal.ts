import { sql, type KobeTx } from "@kobe/db";
import { WORKSPACE_MOVES_PAGE, type WorkspaceMoveRecord } from "@kobe/protocol";
import type { WorkspaceOwner } from "./keys.js";

/**
 * The move journal (`workspace_moves`, KOBE-304): what the sandbox agent replays as local renames,
 * the per-member move budget, and how a retried move is recognised. Team table: every function
 * runs in the caller's `withTeam` transaction and names team and user.
 */

/** Journal rows older than this go (the tombstones of their rows are collected after it too). */
export const MOVE_JOURNAL_TTL = "7 days";
const likeUnder = (folder: string) => `${folder.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;

/** A repeat of a move within this long after it happened answers as that move did. */
const REPEAT_WINDOW = "1 hour";

export interface JournalEntry {
  readonly rev: number;
  readonly from: string;
  readonly to: string;
  readonly type: "file" | "dir";
  readonly files: number;
  readonly bytes: number;
}

export async function recordMove(
  tx: KobeTx,
  owner: WorkspaceOwner,
  entry: JournalEntry,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM workspace_moves
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
       AND created_at < now() - ${sql.raw(`interval '${MOVE_JOURNAL_TTL}'`)}`);
  await tx.execute(sql`
    INSERT INTO workspace_moves (team_id, user_id, rev, from_path, to_path, type, files, bytes)
    VALUES (${owner.teamId}, ${owner.userId}, ${entry.rev}, ${entry.from}, ${entry.to},
            ${entry.type}, ${entry.files}, ${entry.bytes})`);
}

/** Files and bytes the member moved in the last `windowMs`. */
export async function movedRecently(
  tx: KobeTx,
  owner: WorkspaceOwner,
  windowMs: number,
): Promise<{ readonly files: number; readonly bytes: number }> {
  const res = await tx.execute<{ files: string; bytes: string }>(sql`
    SELECT COALESCE(sum(files), 0) AS files, COALESCE(sum(bytes), 0) AS bytes
      FROM workspace_moves
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
       AND created_at > now() - make_interval(secs => ${windowMs / 1000})`);
  const row = res.rows[0];
  return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/**
 * The same move done a moment ago, when its result is still there (a retry after a lost answer):
 * the latest journal row from `from` to `to`, and something live at `to`.
 */
export async function recentRepeat(
  tx: KobeTx,
  owner: WorkspaceOwner,
  from: string,
  to: string,
): Promise<{ readonly type: "file" | "dir"; readonly files: number } | undefined> {
  const res = await tx.execute<{ type: "file" | "dir"; files: number; live: boolean }>(sql`
    SELECT m.type, m.files,
           EXISTS (SELECT 1 FROM workspace_files f
                    WHERE f.team_id = m.team_id AND f.user_id = m.user_id AND NOT f.deleted
                      AND (f.path = ${to} OR f.path LIKE ${likeUnder(to)})) AS live
      FROM workspace_moves m
     WHERE m.team_id = ${owner.teamId} AND m.user_id = ${owner.userId}
       AND m.from_path = ${from} AND m.to_path = ${to}
       AND m.created_at > now() - ${sql.raw(`interval '${REPEAT_WINDOW}'`)}
     ORDER BY m.rev DESC LIMIT 1`);
  const row = res.rows[0];
  return row?.live ? { type: row.type, files: row.files } : undefined;
}

/** Moves whose rows are newer than `since`, oldest first (the sandbox's `GET moves`). */
export async function movesSince(
  tx: KobeTx,
  owner: WorkspaceOwner,
  since: number,
  after = 0,
): Promise<{ readonly moves: WorkspaceMoveRecord[]; readonly more: boolean }> {
  // A move's last row is rev + 2 * files - 1: list it while any of its rows is newer than `since`.
  const res = await tx.execute<{
    rev: string;
    from_path: string;
    to_path: string;
    type: "file" | "dir";
  }>(sql`
    SELECT rev, from_path, to_path, type FROM workspace_moves
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
       AND rev + 2 * files - 1 > ${since} AND rev > ${after}
     ORDER BY rev LIMIT ${WORKSPACE_MOVES_PAGE + 1}`);
  const moves = res.rows.slice(0, WORKSPACE_MOVES_PAGE).map((r) => ({
    rev: Number(r.rev),
    from: r.from_path,
    to: r.to_path,
    type: r.type,
  }));
  return { moves, more: res.rows.length > WORKSPACE_MOVES_PAGE };
}
