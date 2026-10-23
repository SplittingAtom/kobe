import { sql, type KobeDb, type KobeTx } from "@kobe/db";

/**
 * The caller is an active Site Owner or Admin now (KOBE-495): read inside the transaction that
 * acts, on top of the route's session check, so a demotion takes effect on the very next call.
 */
export async function isSiteAdmin(tx: KobeTx | KobeDb, userId: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM site_roles r JOIN users u ON u.id = r.user_id
     WHERE r.user_id = ${userId} AND u.deactivated_at IS NULL AND r.role IN ('owner', 'admin')`);
  return rows.length > 0;
}
