import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";

type SQL = ReturnType<typeof sql>;

/**
 * Legal holds over portable memories (KOBE-386 Q2, coordinator 2026-11-13). A portable item follows
 * its owner into every Workspace they are in, so it is held when an active hold names the owner,
 * or when the owner is a member of a Workspace under a Workspace-wide hold (`legal_holds.user_id`
 * NULL). A Workspace-wide hold on a Workspace the owner is not in does not reach their items.
 * Portable tables have no DB hold guard: these checks, after the hold lock, are their protection
 * (the sweeps, the admin purge and the version cap's prune all use them).
 */

/**
 * Members of every Workspace under an active Workspace-wide hold. Call inside the caller's
 * transaction after `lockLegalHolds` (no hold is approved meanwhile). `team_members` stays behind
 * its RLS: each held Workspace is read in its own `withTeam` (no bypass, no SECURITY DEFINER).
 */
export async function workspaceHeldMembers(db: KobeDb, tx: KobeTx): Promise<string[]> {
  const holds = await tx.execute<{ team_id: string }>(sql`
    SELECT DISTINCT team_id FROM legal_holds WHERE status = 'active' AND user_id IS NULL`);
  const members = new Set<string>();
  for (const { team_id } of holds.rows) {
    const rows = await withTeam(db, team_id, (t) =>
      t.execute<{ user_id: string }>(
        sql`SELECT user_id FROM team_members WHERE team_id = ${team_id}`,
      ),
    );
    for (const r of rows.rows) members.add(r.user_id);
  }
  return [...members];
}

/** The owner (SQL value or column) is free of holds, given `frozen` from {@link workspaceHeldMembers}. */
export const portableOwnerUnheld = (owner: SQL, frozen: readonly string[]): SQL => {
  const notFrozen =
    frozen.length === 0
      ? sql`true`
      : sql`NOT (${owner}::text = ANY(ARRAY[${sql.join(
          frozen.map((v) => sql`${v}`),
          sql`, `,
        )}]::text[]))`;
  return sql`(NOT EXISTS (
    SELECT 1 FROM legal_holds h WHERE h.status = 'active' AND h.user_id = ${owner})
    AND ${notFrozen})`;
};
