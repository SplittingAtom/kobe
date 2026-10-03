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
  | "hash_mismatch"
  /** The IP or user agent doesn't match the row's commitment, or is present without one (KOBE-17). */
  | "pii_mismatch"
  /** The v1 rows don't match the seal in `audit.chain.upgraded`, or the event is missing (KOBE-17). */
  | "seal_mismatch";

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
  hash_version: number;
  action: string;
  actor_kind: string;
  target: Record<string, unknown>;
  pii_salt: string | null;
  pii_commitment: string | null;
  no_pii: boolean;
  /** The row's hash input for its version (`audit_log_canonical`). */
  canonical: string;
  /** The v2 view of the row (the upgrade seal's input for v1 rows). */
  canonical_v2: string;
  /** Input of `pii_commitment`; null once the salt is erased. */
  pii_canonical: string | null;
}

const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** One step of the upgrade seal over v1 rows (SQL twin: `audit_log_seal_step`). */
export function auditSealStep(prev: string, hash: string, canonicalV2: string): string {
  return digest(`kobe.audit.seal.v1\n${prev}\n${hash}\n${digest(canonicalV2)}`);
}

/** The action the upgrade migration records, sealing every v1 row (KOBE-17). */
export const AUDIT_CHAIN_UPGRADED = "audit.chain.upgraded";

/** Per-row checks that need no neighbours: the version's hash and the IP/user-agent commitment. */
function rowProblem(row: ChainRow, afterUpgrade: boolean): AuditChainProblem | null {
  if (row.hash_version === 1) {
    // v1 rows only exist before the upgrade event. An erased v1 row (salt gone, commitment kept)
    // can't have its v1 hash recomputed: the seal covers it.
    if (afterUpgrade) return "hash_mismatch";
    const erased = row.pii_salt === null && row.pii_commitment !== null;
    if (!erased && digest(row.canonical) !== row.hash) return "hash_mismatch";
  } else if (row.hash_version !== 2 || digest(row.canonical) !== row.hash) {
    return "hash_mismatch";
  }
  if (row.pii_salt !== null) {
    if (row.pii_canonical === null || digest(row.pii_canonical) !== row.pii_commitment) {
      return "pii_mismatch";
    }
  } else if (!row.no_pii) {
    return "pii_mismatch";
  }
  return null;
}

function sealMatches(row: ChainRow, seal: string, throughSeq: number): boolean {
  return (
    row.action === AUDIT_CHAIN_UPGRADED &&
    row.actor_kind === "system" &&
    row.target.seal === seal &&
    row.target.throughSeq === throughSeq
  );
}

/**
 * Recomputes the audit hash chain (KOBE-15, v2 in KOBE-17): every row's hash from its current
 * contents (v1 or v2 form), every prev_hash against the row before, seq continuity, the IP and
 * user agent against their commitment while present, and (from seq 1) the seal over the v1 rows
 * against the `audit.chain.upgraded` event. Detects edited, deleted and inserted rows anywhere
 * before the head; erasing the IP and user agent is not a change. It cannot detect a rewrite of
 * the whole chain from some row on, or the removal of the newest rows, by someone with DDL rights;
 * compare `head` with a copy kept outside the database (audit export / SIEM forwarding, KOBE-19).
 * Starting after seq 1 inside the v1 rows, erased v1 rows are checked by their links only.
 */
export async function verifyAuditChain(
  db: KobeDb,
  options: VerifyOptions = {},
): Promise<AuditChainReport> {
  const batchSize = options.batchSize ?? 1000;
  let expectedSeq = options.fromSeq ?? 1;
  let expectedPrev = options.expectedPrevHash ?? (expectedSeq === 1 ? AUDIT_GENESIS_HASH : null);
  // The seal can only be recomputed from the first row.
  let seal: string | null = expectedSeq === 1 ? AUDIT_GENESIS_HASH : null;
  let lastV1 = 0;
  let afterUpgrade = false;
  let checked = 0;
  let head: AuditChainReport["head"] = null;
  for (;;) {
    const { rows } = await db.execute<ChainRow>(sql`
      SELECT a.seq::text AS seq, a.prev_hash, a.hash, a.hash_version::int AS hash_version,
             a.action, a.actor_kind::text AS actor_kind, a.target, a.pii_salt, a.pii_commitment,
             (a.ip IS NULL AND a.user_agent IS NULL) AS no_pii,
             public.audit_log_canonical(a) AS canonical,
             public.audit_log_canonical_v2(a) AS canonical_v2,
             public.audit_log_pii_canonical(a) AS pii_canonical
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
      const problem = rowProblem(row, afterUpgrade);
      if (problem) return fail(problem);
      if (row.hash_version === 1) {
        if (seal !== null) seal = auditSealStep(seal, row.hash, row.canonical_v2);
        lastV1 = seq;
      } else {
        // The first v2 row after v1 rows is the upgrade event sealing them.
        if (!afterUpgrade && lastV1 > 0 && seal !== null && !sealMatches(row, seal, lastV1)) {
          return fail("seal_mismatch");
        }
        afterUpgrade = true;
      }
      checked += 1;
      head = { seq, hash: row.hash };
      expectedSeq = seq + 1;
      expectedPrev = row.hash;
    }
    if (rows.length < batchSize) {
      if (lastV1 > 0 && !afterUpgrade) {
        return { ok: false, checked, head, problem: { seq: lastV1, kind: "seal_mismatch" } };
      }
      return { ok: true, checked, head };
    }
  }
}
