import { sql, type KobeTx } from "@kobe/db";

/**
 * KOBE-386 review H1: a person who rejoins a Workspace (or is reactivated while still a member)
 * is no longer departed, so their 30-day record is reopened (`retain_until` cleared on the
 * `destroyed` row). Their next departure then records a fresh 30 days (`offboardSandbox` treats a
 * `destroyed` row without `retain_until` as a new departure), and nothing is purged early. The
 * retained volume stays until they wake a sandbox (reinstate.ts drops it) or leave again.
 * Clearing the date only postpones deletion, so it needs no legal-hold lock. Call inside the
 * Workspace's transaction that adds the membership (or under `withTeam`).
 */
export async function reopenRetentionInTx(
  tx: KobeTx,
  teamId: string,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  await tx.execute(sql`
    UPDATE sandboxes SET retain_until = NULL
     WHERE team_id = ${teamId} AND state = 'destroyed' AND retain_until IS NOT NULL
       AND user_id = ANY(ARRAY[${sql.join(
         userIds.map((u) => sql`${u}`),
         sql`, `,
       )}]::uuid[])`);
}

/** Every reopenable row of the Workspace whose person is an active member (the sweep's backstop). */
export async function reopenReturnedInTx(tx: KobeTx, teamId: string): Promise<number> {
  const res = await tx.execute(sql`
    UPDATE sandboxes s SET retain_until = NULL
     WHERE s.team_id = ${teamId} AND s.state = 'destroyed' AND s.retain_until IS NOT NULL
       AND EXISTS (SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id
                    WHERE m.team_id = s.team_id AND m.user_id = s.user_id
                      AND u.deactivated_at IS NULL)`);
  return res.rowCount ?? 0;
}
