import { SYSTEM_ACTOR, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import {
  SYNC_CONFLICT_NOTES_MAX,
  THREAD_FILE_WRITE_TOOLS,
  THREAD_SYNC_CONFLICTS_MAX,
  type SyncConflict,
  type ThreadSyncConflict,
} from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";

/**
 * Workspace sync conflicts (KOBE-492, `workspace_sync_conflicts`; contract sync-conflicts.ts).
 * Rows are names and hashes only. Every query states `team_id` and the member (`user_id`).
 */

export interface ConflictOwner {
  readonly teamId: string;
  readonly userId: string;
}

export interface RecordedConflict {
  readonly id: string;
  readonly threadId: string | undefined;
  readonly runId: string | undefined;
}

/** Runs searched for the last writer (newest first), and how far back. */
const WRITER_RUNS_MAX = 50;
const WRITER_LOOKBACK = "30 days";
/** Rows kept per member: older ones go on insert (resolved or dismissed first). */
export const CONFLICTS_PER_MEMBER_MAX = 200;
/** Settled (resolved or dismissed) rows older than this go on insert. */
const SETTLED_KEEP = "30 days";

const writeTools = sql.join(
  THREAD_FILE_WRITE_TOOLS.map((t) => sql`${t}`),
  sql`, `,
);

/**
 * The thread and run of the member's that last wrote `path` with a Pi `write`/`edit` whose result
 * succeeded (the tool's own record, as KOBE-488's agent files): among the member's own threads,
 * their newest runs only. Undefined when none did.
 */
export async function lastWriter(
  tx: KobeTx,
  owner: ConflictOwner,
  path: string,
): Promise<{ threadId: string; runId: string } | undefined> {
  const res = await tx.execute<{ thread_id: string; run_id: string }>(sql`
    WITH recent AS (
      SELECT r.id, r.thread_id FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${owner.teamId} AND t.team_id = ${owner.teamId}
         AND t.owner_user_id = ${owner.userId} AND t.deleted_at IS NULL
         AND r.created_at > now() - ${WRITER_LOOKBACK}::interval
       ORDER BY r.created_at DESC
       LIMIT ${WRITER_RUNS_MAX})
    SELECT recent.thread_id, recent.id AS run_id
      FROM recent
      JOIN run_events c ON c.team_id = ${owner.teamId} AND c.run_id = recent.id
     WHERE c.type = 'tool.call' AND c.payload->>'tool' IN (${writeTools})
       AND c.payload->'input'->>'path' IN (${path}, ${`/workspace/${path}`}, ${`./${path}`})
       AND EXISTS (
         SELECT 1 FROM run_events res
          WHERE res.team_id = ${owner.teamId} AND res.run_id = c.run_id
            AND res.type = 'tool.result'
            AND res.payload->>'tool_call_id' = c.payload->>'tool_call_id'
            AND (res.payload->>'is_error')::boolean IS NOT TRUE)
     ORDER BY c.created_at DESC, c.seq DESC
     LIMIT 1`);
  const row = res.rows[0];
  return row ? { threadId: row.thread_id, runId: row.run_id } : undefined;
}

/**
 * Records one conflict for the thread that last wrote the path (else none), trims the member's
 * old rows and audits it (ids and hashes only), in one team transaction.
 */
export async function recordConflict(
  db: KobeDb,
  owner: ConflictOwner,
  conflict: SyncConflict,
): Promise<RecordedConflict> {
  return withTeam(db, owner.teamId, async (tx) => {
    const writer = await lastWriter(tx, owner, conflict.path);
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO workspace_sync_conflicts
        (team_id, user_id, thread_id, run_id, path, conflict_path, member_sha256, agent_sha256)
      VALUES (${owner.teamId}, ${owner.userId}, ${writer?.threadId ?? null},
              ${writer?.runId ?? null}, ${conflict.path}, ${conflict.conflict_path},
              ${conflict.member_sha256}, ${conflict.agent_sha256})
      RETURNING id`);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error("sync conflict insert returned nothing");
    await trim(tx, owner);
    await recordAudit(tx, {
      action: "workspace.sync_conflict",
      actor: SYSTEM_ACTOR,
      teamId: owner.teamId,
      target: {
        userId: owner.userId,
        conflictId: id,
        ...(writer ? { threadId: writer.threadId, runId: writer.runId } : {}),
        memberSha256: conflict.member_sha256,
        agentSha256: conflict.agent_sha256,
      },
    });
    return { id, threadId: writer?.threadId, runId: writer?.runId };
  });
}

/** Settled rows past `SETTLED_KEEP`, then anything past the per-member cap (oldest first). */
async function trim(tx: KobeTx, owner: ConflictOwner): Promise<void> {
  await tx.execute(sql`
    DELETE FROM workspace_sync_conflicts
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
       AND (resolved_at IS NOT NULL OR dismissed_at IS NOT NULL)
       AND created_at < now() - ${SETTLED_KEEP}::interval`);
  await tx.execute(sql`
    DELETE FROM workspace_sync_conflicts
     WHERE team_id = ${owner.teamId} AND id IN (
       SELECT id FROM workspace_sync_conflicts
        WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
        ORDER BY created_at DESC, id DESC
        OFFSET ${CONFLICTS_PER_MEMBER_MAX})`);
}

type ConflictRow = {
  readonly id: string;
  readonly path: string;
  readonly conflict_path: string;
  readonly member_sha256: string;
  readonly agent_sha256: string;
  readonly created_at: Date | string;
};

const toConflict = (r: ConflictRow): SyncConflict => ({
  path: r.path,
  conflict_path: r.conflict_path,
  member_sha256: r.member_sha256,
  agent_sha256: r.agent_sha256,
});

/**
 * The thread's conflicts its agent was not told about yet, newest {@link SYNC_CONFLICT_NOTES_MAX}
 * (oldest first); all of them are marked told. `only` limits it to those ids (a mid-run note).
 */
export async function takeAgentNotes(
  db: KobeDb,
  owner: ConflictOwner,
  threadId: string,
  only?: readonly string[],
): Promise<SyncConflict[]> {
  return withTeam(db, owner.teamId, async (tx) => {
    const ids =
      only === undefined
        ? sql``
        : sql`AND id IN (${sql.join(
            only.map((i) => sql`${i}`),
            sql`, `,
          )})`;
    const res = await tx.execute<ConflictRow>(sql`
      UPDATE workspace_sync_conflicts SET agent_notified_at = now()
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
         AND thread_id = ${threadId} AND agent_notified_at IS NULL ${ids}
      RETURNING id, path, conflict_path, member_sha256, agent_sha256, created_at`);
    return [...res.rows]
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(-SYNC_CONFLICT_NOTES_MAX)
      .map(toConflict);
  });
}

/** The thread's unresolved, undismissed conflicts, newest first (the caller checked ownership). */
export async function listThreadConflicts(
  tx: KobeTx,
  owner: ConflictOwner,
  threadId: string,
): Promise<ThreadSyncConflict[]> {
  const res = await tx.execute<ConflictRow>(sql`
    SELECT id, path, conflict_path, member_sha256, agent_sha256, created_at
      FROM workspace_sync_conflicts
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND thread_id = ${threadId}
       AND resolved_at IS NULL AND dismissed_at IS NULL
     ORDER BY created_at DESC, id DESC
     LIMIT ${THREAD_SYNC_CONFLICTS_MAX}`);
  return res.rows.map((r) => ({
    id: r.id,
    ...toConflict(r),
    created_at: new Date(r.created_at).toISOString(),
  }));
}

/** Settles one conflict of the thread; false when there is no such row (idempotent otherwise). */
export async function settleConflict(
  tx: KobeTx,
  owner: ConflictOwner,
  threadId: string,
  conflictId: string,
  action: "resolved" | "dismissed",
): Promise<boolean> {
  const column = action === "resolved" ? sql`resolved_at` : sql`dismissed_at`;
  const res = await tx.execute(sql`
    UPDATE workspace_sync_conflicts SET ${column} = COALESCE(${column}, now())
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
       AND thread_id = ${threadId} AND id = ${conflictId}`);
  return (res.rowCount ?? 0) > 0;
}
