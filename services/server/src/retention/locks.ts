import { sql, type KobeTx } from "@kobe/db";

/**
 * The purge transactions run with a short `lock_timeout` (taken before the legal-hold lock). The
 * audit write that ends them must use the audit chain's own wait instead (it applies its default
 * when the setting is 0), so a busy chain doesn't fail a batch that already did its work.
 */
export async function auditTimeout(tx: KobeTx): Promise<void> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '0'`));
}
