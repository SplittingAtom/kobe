import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";

type SQL = ReturnType<typeof sql>;

/**
 * Legal holds over portable memories (KOBE-386 Q2, coordinator 2026-11-13). A portable item follows
 * its owner into every Workspace they are in, so it is held when an active hold names the owner,
 * or when the owner is a member of a Workspace under a Workspace-wide hold (`legal_holds.user_id`
 * NULL). A Workspace-wide hold on a Workspace the owner is not in does not reach their items.
 * Portable tables have no DB hold guard: these checks, after the hold lock, are their protection
 * (the sweeps, the admin purge and the version cap's prune all use them).
 *
 * `team_members` stays behind its RLS (no bypass, no SECURITY DEFINER, no nested `withTeam`), so
 * the members of held Workspaces are read *before* the caller's transaction
 * ({@link snapshotPortableHolds}, one `withTeam` per held Workspace, never while a pooled
 * connection is held: review M1). Inside the transaction, after `lockLegalHolds`, the caller checks
 * that the set of Workspace-wide holds is still the one the snapshot saw
 * ({@link portableHoldsUnchanged}); if not, it treats the owner as held (the prune) or retries.
 * A membership added to a held Workspace between the snapshot and the delete is not seen (the
 * membership write takes no hold lock); accepted, as the hold itself is fixed under the lock.
 */

export interface PortableHoldSnapshot {
  /** Ids of the active Workspace-wide holds, sorted. */
  readonly holdIds: readonly string[];
  /** Members of the Workspaces those holds cover. */
  readonly members: readonly string[];
}

export const NO_PORTABLE_HOLDS: PortableHoldSnapshot = { holdIds: [], members: [] };

const textArray = (values: readonly string[]) =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

/** Reads the Workspace-wide holds and their Workspaces' members. Call outside any transaction. */
export async function snapshotPortableHolds(db: KobeDb): Promise<PortableHoldSnapshot> {
  const holds = await db.execute<{ id: string; team_id: string }>(sql`
    SELECT id::text AS id, team_id FROM legal_holds
     WHERE status = 'active' AND user_id IS NULL ORDER BY id`);
  if (holds.rows.length === 0) return NO_PORTABLE_HOLDS;
  const members = new Set<string>();
  for (const teamId of new Set(holds.rows.map((h) => h.team_id))) {
    const rows = await withTeam(db, teamId, (t) =>
      t.execute<{ user_id: string }>(
        sql`SELECT user_id FROM team_members WHERE team_id = ${teamId}`,
      ),
    );
    for (const r of rows.rows) members.add(r.user_id);
  }
  return { holdIds: holds.rows.map((h) => h.id), members: [...members] };
}

/** After `lockLegalHolds`: the Workspace-wide holds are still the snapshot's. */
export async function portableHoldsUnchanged(
  tx: KobeTx,
  snapshot: PortableHoldSnapshot,
): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM legal_holds
     WHERE status = 'active' AND user_id IS NULL ORDER BY id`);
  const now = rows.map((r) => r.id);
  return now.length === snapshot.holdIds.length && now.every((id, i) => id === snapshot.holdIds[i]);
}

/** The owner (SQL value or column) is free of holds, given the snapshot's `members`. */
export const portableOwnerUnheld = (owner: SQL, frozen: readonly string[]): SQL => {
  const notFrozen =
    frozen.length === 0 ? sql`true` : sql`NOT (${owner}::text = ANY(${textArray(frozen)}))`;
  return sql`(NOT EXISTS (
    SELECT 1 FROM legal_holds h WHERE h.status = 'active' AND h.user_id = ${owner})
    AND ${notFrozen})`;
};
