import { sql, type KobeTx } from "@kobe/db";

/**
 * Team storage quota (D26, KOBE-143): bytes in `files` plus the live bytes of the team's
 * workspaces. Serialized per team by a transaction-scoped advisory lock: the check and the
 * `files` insert happen under it, so two uploads that each fit alone can't both commit past the
 * limit. (Volume sizes are not counted: they are provisioned per sandbox, not stored by Kobe.)
 */
export async function lockTeamStorage(tx: KobeTx, teamId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.storage:${teamId}`}, 0))`,
  );
}

/** The team's limit: its own `max_bytes`, else the install default. */
export async function storageLimit(
  tx: KobeTx,
  teamId: string,
  defaultBytes: number,
): Promise<number> {
  const res = await tx.execute<{ max_bytes: string | null }>(
    sql`SELECT max_bytes FROM team_storage_quotas WHERE team_id = ${teamId}`,
  );
  const own = res.rows[0]?.max_bytes;
  return own === null || own === undefined ? defaultBytes : Number(own);
}

export async function storageUsed(tx: KobeTx, teamId: string): Promise<number> {
  const res = await tx.execute<{ used: string }>(sql`
    SELECT (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE team_id = ${teamId})
         + (SELECT COALESCE(SUM(live_bytes), 0) FROM workspace_sync WHERE team_id = ${teamId})
           AS used`);
  return Number(res.rows[0]?.used ?? 0);
}
