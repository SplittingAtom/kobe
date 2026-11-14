import { SYSTEM_ACTOR, lockLegalHolds, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Semantic memory retention in a Workspace (v1.3 SM28, KOBE-386), following `memory.ts`: every
 * batch runs in one team transaction that takes the legal-hold lock first and skips what a hold
 * covers (`memory_legal_hold_covers`: a `user` item with its owner, a `team` item with any active
 * hold in its Workspace). A live (active) item is never purged and never by age alone.
 *  - archived and superseded items whose last change is older than the Workspace window go with
 *    every version (an item another item names as `superseded_by` waits for that one);
 *  - earlier versions replaced longer ago than the window go; never the current version, and
 *    never a version a run used (run history survives; the 0222 guard refuses those deletes);
 *  - evidence (quotes, thread and entry links) is dropped from versions whose source conversation
 *    was purged: the retention scrub 0217/0222 allow. The thread purge does it in its own batch
 *    ({@link scrubEvidenceInTx}); this sweep catches every other way a thread goes, and versions
 *    a hold kept until it was released. The memory itself stays ("source deleted").
 * Offboarding ({@link purgeDepartedSemanticInTx}): a departed member's `user` items in the
 * Workspace 30 days after they left. `team` items stay whoever wrote them ("former member").
 * Audited with counts only (`retention.semantic_memory_purged`).
 */

const BATCH_ITEMS = 200;
const BATCH_VERSIONS = 500;
export const BATCH_SCRUB = 500;

export interface SemanticPurgeCounts {
  readonly items: number;
  readonly versions: number;
  readonly scrubbed: number;
}

export const NO_SEMANTIC_PURGE: SemanticPurgeCounts = { items: 0, versions: 0, scrubbed: 0 };

const add = (a: SemanticPurgeCounts, b: SemanticPurgeCounts): SemanticPurgeCounts => ({
  items: a.items + b.items,
  versions: a.versions + b.versions,
  scrubbed: a.scrubbed + b.scrubbed,
});

const uuidArray = (ids: readonly string[]) =>
  sql`ARRAY[${sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  )}]::uuid[]`;

const NOT_HELD = sql`NOT public.memory_legal_hold_covers(i.team_id, i.owner_user_id)`;

/**
 * Drops the evidence of the team's versions whose source thread is gone (`threadIds`: only those
 * threads, the thread purge's batch; omitted: every thread no longer in the Workspace). Skips
 * held items (the 0222 trigger would refuse them with KH001). Call after the hold lock.
 */
export async function scrubEvidenceInTx(
  tx: KobeTx,
  teamId: string,
  threadIds?: readonly string[],
): Promise<number> {
  if (threadIds !== undefined && threadIds.length === 0) return 0;
  const gone =
    threadIds === undefined
      ? sql`NOT EXISTS (SELECT 1 FROM threads t
                         WHERE t.team_id = v.team_id AND t.id = v.source_thread_id)`
      : sql`v.source_thread_id = ANY(${uuidArray(threadIds)})`;
  // Bounded (review L4): the sweep repeats it; a thread batch names at most its own threads.
  const res = await tx.execute(sql`
    UPDATE semantic_memory_item_versions d
       SET evidence = NULL, source_thread_id = NULL, source_entry_ids = NULL
     WHERE d.team_id = ${teamId} AND (d.item_id, d.version) IN (
       SELECT v.item_id, v.version FROM semantic_memory_item_versions v
         JOIN semantic_memory_items i ON i.team_id = v.team_id AND i.id = v.item_id
        WHERE v.team_id = ${teamId} AND v.source_thread_id IS NOT NULL AND ${gone} AND ${NOT_HELD}
        LIMIT ${BATCH_SCRUB})`);
  return res.rowCount ?? 0;
}

/** Archived or superseded items unchanged since before `cutoff` that nothing supersedes into. */
async function itemBatch(tx: KobeTx, teamId: string, cutoff: Date): Promise<SemanticPurgeCounts> {
  const at = cutoff.toISOString();
  const versions = await tx.execute<{ n: number }>(sql`
    WITH doomed AS (
      SELECT i.id FROM semantic_memory_items i
       WHERE i.team_id = ${teamId} AND i.status IN ('archived', 'superseded')
         AND i.updated_at < ${at} AND ${NOT_HELD}
         AND NOT EXISTS (SELECT 1 FROM semantic_memory_items r
                          WHERE r.team_id = i.team_id AND r.superseded_by = i.id)
       ORDER BY i.updated_at, i.id LIMIT ${BATCH_ITEMS}
         FOR UPDATE OF i SKIP LOCKED),
    gone AS (
      DELETE FROM semantic_memory_items i USING doomed d
       WHERE i.team_id = ${teamId} AND i.id = d.id
       RETURNING i.id)
    SELECT (SELECT count(*) FROM gone)::int AS items,
           (SELECT count(*) FROM semantic_memory_item_versions v
             WHERE v.team_id = ${teamId} AND v.item_id IN (SELECT id FROM gone))::int AS n`);
  const row = versions.rows[0] as { items?: number; n?: number } | undefined;
  return { items: row?.items ?? 0, versions: row?.n ?? 0, scrubbed: 0 };
}

/** Non-current versions replaced before `cutoff` that no run used. */
async function versionBatch(
  tx: KobeTx,
  teamId: string,
  cutoff: Date,
): Promise<SemanticPurgeCounts> {
  const res = await tx.execute(sql`
    DELETE FROM semantic_memory_item_versions d
     USING (
       SELECT v.item_id, v.version FROM semantic_memory_item_versions v
         JOIN semantic_memory_items i ON i.team_id = v.team_id AND i.id = v.item_id
        WHERE v.team_id = ${teamId} AND v.version <> i.current_version AND ${NOT_HELD}
          AND NOT EXISTS (SELECT 1 FROM run_memory_items r
                           WHERE r.team_id = v.team_id AND r.item_id = v.item_id
                             AND r.version = v.version)
          AND (SELECT min(n.created_at) FROM semantic_memory_item_versions n
                WHERE n.team_id = v.team_id AND n.item_id = v.item_id AND n.version > v.version
              ) < ${cutoff.toISOString()}
        ORDER BY v.created_at, v.item_id, v.version
        LIMIT ${BATCH_VERSIONS}) k
     WHERE d.team_id = ${teamId} AND d.item_id = k.item_id AND d.version = k.version`);
  return { items: 0, versions: res.rowCount ?? 0, scrubbed: 0 };
}

async function audited(
  tx: KobeTx,
  teamId: string,
  reason: "retention" | "offboarding",
  counts: SemanticPurgeCounts,
  userId?: string,
): Promise<void> {
  // An offboarding purge is always recorded, even one that found nothing (review L2).
  if (reason === "retention" && counts.items + counts.versions + counts.scrubbed === 0) return;
  await recordAudit(tx, {
    action: "retention.semantic_memory_purged",
    actor: SYSTEM_ACTOR,
    teamId,
    target: { reason, ...counts, ...(userId ? { userId } : {}) },
  });
}

/** One batch in its own team transaction, hold lock first; audited when it removed something. */
function batch(
  db: KobeDb,
  teamId: string,
  one: (tx: KobeTx) => Promise<SemanticPurgeCounts>,
): Promise<SemanticPurgeCounts> {
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
    await lockLegalHolds(tx);
    const counts = await one(tx);
    await audited(tx, teamId, "retention", counts);
    return counts;
  });
}

async function repeat(
  db: KobeDb,
  teamId: string,
  stop: (() => boolean) | undefined,
  one: (tx: KobeTx) => Promise<SemanticPurgeCounts>,
): Promise<SemanticPurgeCounts> {
  let total = NO_SEMANTIC_PURGE;
  for (let n = 0; n < 1000; n++) {
    if (stop?.()) break;
    const counts = await batch(db, teamId, one);
    total = add(total, counts);
    if (counts.items + counts.versions === 0) break;
  }
  return total;
}

/**
 * The Workspace's semantic memory past its window (`cutoff`; null: kept forever, so only the
 * evidence scrub runs). Called by the nightly retention pass for every team.
 */
export async function purgeSemanticMemory(
  db: KobeDb,
  teamId: string,
  cutoff: Date | null,
  options: { readonly stop?: () => boolean } = {},
): Promise<SemanticPurgeCounts> {
  let scrubbed = NO_SEMANTIC_PURGE;
  for (let n = 0; n < 1000 && !options.stop?.(); n++) {
    const one = await batch(db, teamId, async (tx) => ({
      ...NO_SEMANTIC_PURGE,
      scrubbed: await scrubEvidenceInTx(tx, teamId),
    }));
    scrubbed = add(scrubbed, one);
    if (one.scrubbed < BATCH_SCRUB) break;
  }
  if (cutoff === null) return scrubbed;
  const items = await repeat(db, teamId, options.stop, (tx) => itemBatch(tx, teamId, cutoff));
  const versions = await repeat(db, teamId, options.stop, (tx) => versionBatch(tx, teamId, cutoff));
  return add(scrubbed, add(items, versions));
}

/** The person is an active member of the Workspace (a member, not deactivated). */
export const activeMember = (teamId: string, userId: string) => sql`EXISTS (
  SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id
   WHERE m.team_id = ${teamId} AND m.user_id = ${userId} AND u.deactivated_at IS NULL)`;

/**
 * Offboarding step (inside the caller's guarded team transaction, after its hold check): every
 * `user` item of a departed member in the Workspace, with its versions and run records, in one
 * statement (an item and the one superseding it go together). Nothing when the person is an
 * active member again (a return before the purge keeps their memories) or a hold covers them.
 */
export async function purgeDepartedSemanticInTx(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<SemanticPurgeCounts> {
  await lockLegalHolds(tx);
  const res = await tx.execute<{ items: number; versions: number }>(sql`
    WITH gone AS (
      DELETE FROM semantic_memory_items i
       WHERE i.team_id = ${teamId} AND i.scope = 'user' AND i.owner_user_id = ${userId}
         AND NOT ${activeMember(teamId, userId)} AND ${NOT_HELD}
       RETURNING i.id)
    SELECT (SELECT count(*) FROM gone)::int AS items,
           (SELECT count(*) FROM semantic_memory_item_versions v
             WHERE v.team_id = ${teamId} AND v.item_id IN (SELECT id FROM gone))::int AS versions`);
  const counts = {
    items: res.rows[0]?.items ?? 0,
    versions: res.rows[0]?.versions ?? 0,
    scrubbed: 0,
  };
  await audited(tx, teamId, "offboarding", counts, userId);
  return counts;
}

/** Whether the member owns `user` items in the Workspace (offboarding keeps a record for them). */
export async function ownsPersonalItems(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const res = await tx.execute(sql`
    SELECT 1 FROM semantic_memory_items
     WHERE team_id = ${teamId} AND scope = 'user' AND owner_user_id = ${userId} LIMIT 1`);
  return (res.rowCount ?? 0) > 0;
}
