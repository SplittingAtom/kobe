import { sql } from "drizzle-orm";
import { z } from "zod";
import type { KobeDb, KobeTx } from "../client.js";
import { lockLegalHolds } from "../legal-hold/index.js";

/**
 * Erasure of the client IP and user agent recorded with audit events (KOBE-17; user decision
 * 2026-10-03). Rows are kept forever; after the retention period their `ip`, `user_agent` and
 * `pii_salt` are set to NULL. The hash chain covers a salted commitment to those values, not the
 * values, so it still verifies (docs/audit-log.md, "IP and user agent").
 */

/** `install_settings.key` of the retention period, in whole hours. */
export const AUDIT_PII_RETENTION_KEY = "audit.pii_retention_hours";
export const AUDIT_PII_RETENTION_DEFAULT_HOURS = 12;
/** Bounds, enforced here and again in SQL (`audit_pii_retention_hours()` clamps). */
export const AUDIT_PII_RETENTION_MIN_HOURS = 1;
export const AUDIT_PII_RETENTION_MAX_HOURS = 8760;

export const auditPiiRetentionHoursSchema = z
  .number()
  .int()
  .min(AUDIT_PII_RETENTION_MIN_HOURS)
  .max(AUDIT_PII_RETENTION_MAX_HOURS);

/** The effective retention period in hours (the database's reading of the setting). */
export async function readAuditPiiRetentionHours(db: KobeDb | KobeTx): Promise<number> {
  const { rows } = await db.execute<{ hours: number }>(
    sql`SELECT public.audit_pii_retention_hours() AS hours`,
  );
  return Number(rows[0]?.hours ?? AUDIT_PII_RETENTION_DEFAULT_HOURS);
}

export interface AuditPiiErasure {
  /** Rows whose IP and user agent were erased now. */
  readonly rows: number;
  /** Rows past the period kept because of an active legal hold. */
  readonly held: number;
  /** The retention period applied, in hours. */
  readonly olderThanHours: number;
}

/**
 * Erases the IP and user agent of up to `limit` rows older than the retention period and not
 * under legal hold, in `tx`. Takes the legal-hold lock shared first (a hold approved meanwhile
 * waits; one approved before is seen), and skips rows another replica is erasing. The update
 * trigger re-checks age and hold for every row. Record `audit.pii_erased` in the same
 * transaction when `rows > 0`.
 */
export async function eraseExpiredAuditPii(tx: KobeTx, limit: number): Promise<AuditPiiErasure> {
  await lockLegalHolds(tx);
  const olderThanHours = await readAuditPiiRetentionHours(tx);
  const cutoff = sql`now() - make_interval(hours => ${olderThanHours}::integer)`;
  const erased = await tx.execute<{ seq: string }>(sql`
    WITH due AS (
      SELECT a.seq FROM public.audit_log a
      WHERE a.pii_salt IS NOT NULL AND a.at < ${cutoff}
        AND NOT public.audit_log_pii_held(a.team_id, a.actor_id)
      ORDER BY a.at
      LIMIT ${Math.trunc(limit)}
      FOR UPDATE SKIP LOCKED)
    UPDATE public.audit_log a SET ip = NULL, user_agent = NULL, pii_salt = NULL
    FROM due WHERE a.seq = due.seq
    RETURNING a.seq`);
  const held = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.audit_log a
    WHERE a.pii_salt IS NOT NULL AND a.at < ${cutoff}
      AND public.audit_log_pii_held(a.team_id, a.actor_id)`);
  return { rows: erased.rows.length, held: Number(held.rows[0]?.n ?? 0), olderThanHours };
}
