import { sql, type KobeTx } from "@kobe/db";

/**
 * The purge transactions run with a short `lock_timeout` (taken before the legal-hold lock). The
 * audit write that ends them must use the audit chain's own wait instead (it applies its default
 * when the setting is 0), so a busy chain doesn't fail a batch that already did its work.
 */
export async function auditTimeout(tx: KobeTx): Promise<void> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '0'`));
}

/** Postgres lock_not_available (`lock_timeout` expired) and deadlock_detected. */
const LOCK_CONFLICTS: ReadonlySet<string> = new Set(["55P03", "40P01"]);

/**
 * A batch lost a lock wait (55P03) or was chosen as a deadlock victim (40P01). Its transaction
 * rolled back whole, so the purge is simply retried on the next pass. Reads the code on the error
 * or its `cause` (drizzle wraps the driver's error).
 */
export function isLockConflict(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" && LOCK_CONFLICTS.has(code);
}
