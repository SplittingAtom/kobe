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

/** Where the sweep continues (`install_settings`): every row before it has been dealt with. */
export const AUDIT_PII_SWEEP_SEQ_KEY = "audit.pii_sweep_seq";
/** Written by `kobe restore`: no erasure until then (ISO time, 24 h after the restore). */
export const AUDIT_PII_SWEEP_RESUME_KEY = "audit.pii_sweep_resume_at";
/** Set once v1 rows became erasable (the sweep then starts over once to reach them). */
const V1_OPEN_KEY = "audit.pii_v1_open";

export interface AuditPiiErasure {
  /** Rows whose IP and user agent were erased now. */
  readonly rows: number;
  /** The retention period applied, in hours. */
  readonly olderThanHours: number;
  /** More rows may be due right now: run another page. */
  readonly more: boolean;
}

interface PageRow extends Record<string, unknown> {
  seq: string;
  has_pii: boolean;
  due: boolean;
  v1: boolean;
  held: boolean;
}

async function setSetting(tx: KobeTx, key: string, value: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.install_settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`);
}

/**
 * One page of the erasure sweep, in `tx`: walks up to `pageSize` rows from the sweep's position
 * (by seq, the primary key) and erases the IP and user agent of those older than the retention
 * period that no legal hold covers. Returns null when another replica is sweeping (one at a time:
 * transaction-level try-lock). The position moves past rows that are done (no values left), held,
 * or v1 rows not erasable yet, and stops at the first row still inside the period, so a run reads
 * each row about once and held rows are not re-read every run. It restarts from the first row once
 * when a hold is released (the legal_holds_guard trigger resets it) and once when v1 rows become
 * erasable (24 h after the upgrade seal). The update trigger re-checks age, hold and version for
 * every row. Record `audit.pii_erased` in the same transaction when `rows > 0`.
 */
export async function eraseExpiredAuditPii(
  tx: KobeTx,
  pageSize: number,
): Promise<AuditPiiErasure | null> {
  const locked = await tx.execute<{ ok: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended('kobe.audit.pii_sweep', 0)) AS ok`,
  );
  if (!locked.rows[0]?.ok) return null;
  await lockLegalHolds(tx);
  const olderThanHours = await readAuditPiiRetentionHours(tx);
  const state = await tx.execute<{
    position: string | null;
    v1_open: boolean;
    v1_marked: boolean;
    paused: boolean;
  }>(
    sql`SELECT
          (SELECT value FROM public.install_settings WHERE key = ${AUDIT_PII_SWEEP_SEQ_KEY}) AS position,
          COALESCE((SELECT CASE WHEN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN value::timestamptz > now() END
                    FROM public.install_settings WHERE key = ${AUDIT_PII_SWEEP_RESUME_KEY}), false) AS paused,
          public.audit_log_v1_erasable() AS v1_open,
          EXISTS (SELECT 1 FROM public.install_settings WHERE key = ${V1_OPEN_KEY}) AS v1_marked`,
  );
  const s = state.rows[0];
  // Paused after a restore (holds are as of the backup; admins re-place newer ones meanwhile).
  if (s?.paused) return { rows: 0, olderThanHours, more: false };
  let position = /^\d{1,18}$/.test(s?.position ?? "") ? Number(s?.position) : 0;
  const v1Open = s?.v1_open === true;
  if (v1Open && !s?.v1_marked) {
    await setSetting(tx, V1_OPEN_KEY, "true");
    position = 0;
  }
  const cutoff = sql`now() - make_interval(hours => ${olderThanHours}::integer)`;
  const page = await tx.execute<PageRow>(sql`
    SELECT a.seq::text AS seq,
           (a.ip IS NOT NULL OR a.user_agent IS NOT NULL) AS has_pii,
           a.at < ${cutoff} AS due,
           a.hash_version IS NULL AS v1,
           CASE WHEN (a.ip IS NOT NULL OR a.user_agent IS NOT NULL) AND a.at < ${cutoff}
                THEN public.audit_log_pii_held(a.team_id, a.actor_id) ELSE false END AS held
    FROM public.audit_log a WHERE a.seq >= ${position}
    ORDER BY a.seq LIMIT ${Math.trunc(pageSize)}`);
  const erasable: number[] = [];
  let firstPending: number | null = null;
  for (const row of page.rows) {
    const seq = Number(row.seq);
    if (!row.has_pii) continue;
    if (!row.due) {
      firstPending ??= seq;
      continue;
    }
    if (row.held || (row.v1 && !v1Open)) continue;
    erasable.push(seq);
  }
  let rows = 0;
  if (erasable.length > 0) {
    const erased = await tx.execute<{ seq: string }>(sql`
      UPDATE public.audit_log SET ip = NULL, user_agent = NULL, pii_salt = NULL
      WHERE seq = ANY(${`{${erasable.join(",")}}`}::bigint[])
      RETURNING seq`);
    rows = erased.rows.length;
  }
  const last = page.rows.at(-1);
  const next = firstPending ?? (last ? Number(last.seq) + 1 : position);
  if (next !== position || s?.position === null || s?.position === undefined) {
    await setSetting(tx, AUDIT_PII_SWEEP_SEQ_KEY, String(next));
  }
  return { rows, olderThanHours, more: firstPending === null && page.rows.length >= pageSize };
}
