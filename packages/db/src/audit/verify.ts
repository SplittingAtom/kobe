import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { KobeDb } from "../client.js";

/** prev_hash of the first row (seq 1). */
export const AUDIT_GENESIS_HASH = "0".repeat(64);

export type AuditChainProblem =
  /** A seq is missing (a row was deleted) or out of place. */
  | "gap"
  /** prev_hash doesn't name the previous row's hash (a row was removed, inserted or re-chained). */
  | "prev_hash_mismatch"
  /** The row's contents don't match its hash (the row was edited, or inserted bypassing the trigger). */
  | "hash_mismatch";

export interface AuditChainReport {
  readonly ok: boolean;
  /** Rows checked. */
  readonly checked: number;
  /** Last row checked (anchor this outside the database: export, SIEM). */
  readonly head: { readonly seq: number; readonly hash: string } | null;
  readonly problem?: { readonly seq: number; readonly kind: AuditChainProblem };
}

export interface VerifyOptions {
  /** Start here instead of seq 1 (incremental checks from a previously anchored head). */
  readonly fromSeq?: number;
  /** prev_hash expected at `fromSeq` (the anchored hash of `fromSeq - 1`). */
  readonly expectedPrevHash?: string;
  readonly batchSize?: number;
}

interface ChainRow extends Record<string, unknown> {
  seq: string;
  prev_hash: string;
  hash: string;
  canonical: string;
}

/**
 * Recomputes the audit hash chain (KOBE-15): every row's hash from its current contents, every
 * prev_hash against the row before, and seq continuity. Detects edited, deleted and inserted rows
 * anywhere before the head. It cannot detect a rewrite of the whole chain from some row on, or the
 * removal of the newest rows, by someone with DDL rights; compare `head` with a copy kept outside
 * the database (audit export / SIEM forwarding, KOBE-19) for that.
 */
export async function verifyAuditChain(
  db: KobeDb,
  options: VerifyOptions = {},
): Promise<AuditChainReport> {
  const batchSize = options.batchSize ?? 1000;
  let expectedSeq = options.fromSeq ?? 1;
  let expectedPrev = options.expectedPrevHash ?? (expectedSeq === 1 ? AUDIT_GENESIS_HASH : null);
  let checked = 0;
  let head: AuditChainReport["head"] = null;
  for (;;) {
    const { rows } = await db.execute<ChainRow>(sql`
      SELECT a.seq::text AS seq, a.prev_hash, a.hash, public.audit_log_canonical(a) AS canonical
      FROM public.audit_log a WHERE a.seq >= ${expectedSeq}
      ORDER BY a.seq LIMIT ${batchSize}`);
    for (const row of rows) {
      const seq = Number(row.seq);
      const fail = (kind: AuditChainProblem): AuditChainReport => ({
        ok: false,
        checked,
        head,
        problem: { seq, kind },
      });
      if (seq !== expectedSeq) return fail("gap");
      if (expectedPrev !== null && row.prev_hash !== expectedPrev) {
        return fail("prev_hash_mismatch");
      }
      const hash = createHash("sha256").update(row.canonical, "utf8").digest("hex");
      if (hash !== row.hash) return fail("hash_mismatch");
      checked += 1;
      head = { seq, hash: row.hash };
      expectedSeq = seq + 1;
      expectedPrev = row.hash;
    }
    if (rows.length < batchSize) return { ok: true, checked, head };
  }
}
