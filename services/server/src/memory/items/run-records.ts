import { sql, type KobeTx } from "@kobe/db";
import {
  semanticMemoryRunRank,
  type RunSemanticMemoryItem,
  type SemanticMemoryActorKind,
  type SemanticMemoryKind,
  type SemanticMemoryScope,
  type ThreadContextMemoryItem,
} from "@kobe/protocol";
import { RENDER_LANES } from "./select.js";

type SQL = ReturnType<typeof sql>;

/**
 * Run records of semantic memory (KOBE-382, U48): which item versions a run was given, in
 * `run_memory_items` (personal and Workspace items), `run_portable_memory_items` and
 * `run_site_memory_items` (Site and Policy). Written once the sandbox accepted the `run.start`
 * that carried them; read back for a redelivered start (the same selection, no second set) and
 * for the owner's context viewer and Session info.
 */

const RUN_TABLES: Record<SemanticMemoryScope, SQL> = {
  user: sql.raw("run_memory_items"),
  team: sql.raw("run_memory_items"),
  portable: sql.raw("run_portable_memory_items"),
  site: sql.raw("run_site_memory_items"),
};

/** One row per item version given to the run, in one statement. Never deletes (legal holds). */
export async function recordRunMemory(
  tx: KobeTx,
  teamId: string,
  runId: string,
  items: readonly RunSemanticMemoryItem[],
): Promise<void> {
  const inserts = [...new Set(Object.values(RUN_TABLES))].flatMap((table) => {
    const rows = items.filter((i) => RUN_TABLES[i.scope] === table);
    return rows.length === 0
      ? []
      : [
          sql`INSERT INTO ${table} (team_id, run_id, item_id, version)
              VALUES ${sql.join(
                rows.map(
                  (i) => sql`(${teamId}::uuid, ${runId}::uuid, ${i.id}::uuid, ${i.version})`,
                ),
                sql`, `,
              )}
              ON CONFLICT DO NOTHING`,
        ];
  });
  const last = inserts.pop();
  if (last === undefined) return;
  // The other tables' inserts ride along as data-modifying CTEs.
  const ctes = inserts.map((ins, i) => sql`${sql.raw(`w${i}`)} AS (${ins})`);
  await tx.execute(ctes.length === 0 ? last : sql`WITH ${sql.join(ctes, sql`, `)} ${last}`);
}

type Lane = ThreadContextMemoryItem["lane"];

interface RecordRow extends Record<string, unknown> {
  readonly id: string;
  readonly version: number;
  readonly lane: Lane;
  readonly kind: SemanticMemoryKind;
  readonly statement: string;
  readonly pinned: boolean;
  readonly actor_kind: SemanticMemoryActorKind;
  readonly as_of: string | null;
  readonly saved_on: string;
}

const laneIndex = (lane: Lane) => (lane === "policy" ? -1 : RENDER_LANES.indexOf(lane));
const rankOf = (r: { lane: Lane; pinned: boolean }) =>
  semanticMemoryRunRank({ policy: r.lane === "policy", pinned: r.pinned });

/**
 * The item versions run `runId` was given, in the block's order (Policy, pinned, picks; lane,
 * then id). Personal and portable rows only when they are `userId`'s own: the runner is the
 * thread's owner, and this is the wall, not a convenience.
 */
export async function readRunRecords(
  tx: KobeTx,
  teamId: string,
  userId: string,
  runId: string,
): Promise<RecordRow[]> {
  const saved = (v: string) =>
    sql.raw(`to_char(${v}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS saved_on`);
  const { rows } = await tx.execute<RecordRow>(sql`
    SELECT i.id, r.version, i.scope AS lane, i.kind, v.statement, i.pinned, v.actor_kind,
           to_char(i.as_of, 'YYYY-MM-DD') AS as_of, ${saved("v")}
      FROM run_memory_items r
      JOIN semantic_memory_items i ON i.team_id = r.team_id AND i.id = r.item_id
      JOIN semantic_memory_item_versions v
        ON v.team_id = r.team_id AND v.item_id = r.item_id AND v.version = r.version
     WHERE r.team_id = ${teamId} AND r.run_id = ${runId}
       AND (i.scope = 'team' OR i.owner_user_id = ${userId})
    UNION ALL
    SELECT i.id, r.version, 'portable', i.kind, v.statement, i.pinned, v.actor_kind, NULL,
           ${saved("v")}
      FROM run_portable_memory_items r
      JOIN portable_memory_items i ON i.id = r.item_id
      JOIN portable_memory_item_versions v ON v.item_id = r.item_id AND v.version = r.version
     WHERE r.team_id = ${teamId} AND r.run_id = ${runId} AND i.owner_user_id = ${userId}
    UNION ALL
    SELECT i.id, r.version, CASE WHEN i.policy THEN 'policy' ELSE 'site' END, i.kind,
           v.statement, i.pinned AND NOT i.policy, v.actor_kind,
           to_char(i.as_of, 'YYYY-MM-DD'), ${saved("v")}
      FROM run_site_memory_items r
      JOIN site_memory_items i ON i.id = r.item_id
      JOIN site_memory_item_versions v ON v.item_id = r.item_id AND v.version = r.version
     WHERE r.team_id = ${teamId} AND r.run_id = ${runId}`);
  return [...rows].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      laneIndex(a.lane) - laneIndex(b.lane) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** A record as a `run.start.memory.semantic` item (a redelivered start gives the same). */
export const recordToRunItem = (r: RecordRow): RunSemanticMemoryItem => ({
  id: r.id,
  version: Number(r.version),
  scope: r.lane === "policy" ? "site" : r.lane,
  kind: r.kind,
  statement: r.statement,
  policy: r.lane === "policy",
  pinned: r.pinned,
  provenance: { actor_kind: r.actor_kind, as_of: r.as_of, saved_on: r.saved_on },
});

/**
 * What the context viewer and Session info show (KOBE-382, U48): the records of the thread's
 * latest message run that has any (`latest` false when a newer run, queued or without memories,
 * came after it), for the thread's owner `userId`. `runId` null: no run has records yet.
 */
export async function readThreadMemories(
  tx: KobeTx,
  teamId: string,
  userId: string,
  threadId: string,
): Promise<{ runId: string | null; latest: boolean; items: ThreadContextMemoryItem[] }> {
  const res = await tx.execute<{ id: string | null; newest: string | null }>(sql`
    SELECT (SELECT r.id FROM runs r
             WHERE r.team_id = ${teamId} AND r.thread_id = ${threadId} AND r.kind = 'message'
               AND (EXISTS (SELECT 1 FROM run_memory_items m
                             WHERE m.team_id = r.team_id AND m.run_id = r.id)
                 OR EXISTS (SELECT 1 FROM run_portable_memory_items m
                             WHERE m.team_id = r.team_id AND m.run_id = r.id)
                 OR EXISTS (SELECT 1 FROM run_site_memory_items m
                             WHERE m.team_id = r.team_id AND m.run_id = r.id))
             ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS id,
           (SELECT r.id FROM runs r
             WHERE r.team_id = ${teamId} AND r.thread_id = ${threadId} AND r.kind = 'message'
             ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS newest`);
  const row = res.rows[0];
  const runId = row?.id ?? null;
  if (runId === null) return { runId, latest: true, items: [] };
  const records = await readRunRecords(tx, teamId, userId, runId);
  return {
    runId,
    latest: runId === row?.newest,
    items: records.map((r) => ({
      id: r.id,
      version: Number(r.version),
      lane: r.lane,
      kind: r.kind,
      statement: r.statement,
      pinned: r.pinned,
    })),
  };
}
