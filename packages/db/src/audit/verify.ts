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
  /** null: v1 (chained before the upgrade); 2: v2. */
  hash_version: number | null;
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

/** The action that seals every v1 row (KOBE-17), appended by the server after the upgrade. */
export const AUDIT_CHAIN_UPGRADED = "audit.chain.upgraded";

/** The SELECT both verifiers and the sealer read rows with. */
export const chainRowsFrom = (fromSeq: number, limit: number, where = sql`true`) => sql`
  SELECT a.seq::text AS seq, a.prev_hash, a.hash, a.hash_version::int AS hash_version,
         a.action, a.actor_kind::text AS actor_kind, a.target, a.pii_salt, a.pii_commitment,
         (a.ip IS NULL AND a.user_agent IS NULL) AS no_pii,
         public.audit_log_canonical(a) AS canonical,
         public.audit_log_canonical_v2(a) AS canonical_v2,
         public.audit_log_pii_canonical(a) AS pii_canonical
  FROM public.audit_log a WHERE a.seq >= ${fromSeq} AND ${where}
  ORDER BY a.seq LIMIT ${limit}`;

export type AuditChainRow = ChainRow;

/** Outcome of a v1 row's own check: ok, erased (needs the seal), or a problem. */
function v1Row(row: ChainRow, afterV2: boolean): AuditChainProblem | "ok" | "erased" {
  if (afterV2) return "hash_mismatch";
  if (row.pii_salt !== null || row.pii_commitment !== null) return "pii_mismatch";
  if (digest(row.canonical) === row.hash) return "ok";
  // A v1 hash covers the raw values: once erased it can't be recomputed; the seal vouches for it.
  return row.no_pii ? "erased" : "hash_mismatch";
}

function v2Row(row: ChainRow): AuditChainProblem | null {
  if (row.hash_version !== 2 || digest(row.canonical) !== row.hash) return "hash_mismatch";
  if (row.pii_salt !== null) {
    if (row.pii_canonical === null || digest(row.pii_canonical) !== row.pii_commitment) {
      return "pii_mismatch";
    }
  } else if (!row.no_pii) {
    return "pii_mismatch";
  }
  return null;
}

const isUpgradeEvent = (row: ChainRow) =>
  row.action === AUDIT_CHAIN_UPGRADED && row.actor_kind === "system";

function sealMatches(row: ChainRow, seal: string, throughSeq: number): boolean {
  return (
    throughSeq > 0 &&
    typeof row.target.throughSeq === "number" &&
    row.target.throughSeq === throughSeq &&
    row.target.seal === seal
  );
}

/**
 * Recomputes the audit hash chain (KOBE-15, v2 in KOBE-17): every row's hash from its current
 * contents (v1 or v2 form), every prev_hash against the row before, seq continuity, the IP and
 * user agent against their commitment while present, and (from seq 1) the seal over the v1 rows
 * against every `audit.chain.upgraded` event. An erased v1 row (v1 hash no longer recomputable,
 * IP and user agent gone) passes only under a valid seal. Detects edited, deleted and inserted rows
 * anywhere before the head; erasing the IP and user agent is not a change. It cannot detect a
 * rewrite of the whole chain from some row on, or the removal of the newest rows, by someone with
 * DDL rights; compare `head` with a copy kept outside the database (KOBE-19). Starting after seq 1
 * the seal can't be recomputed: an erased v1 row then passes when an upgrade event follows.
 * SQL twin: `audit_log_chain_problem()`.
 */
export async function verifyAuditChain(
  db: KobeDb,
  options: VerifyOptions = {},
): Promise<AuditChainReport> {
  const batchSize = options.batchSize ?? 1000;
  let expectedSeq = options.fromSeq ?? 1;
  let expectedPrev = options.expectedPrevHash ?? (expectedSeq === 1 ? AUDIT_GENESIS_HASH : null);
  const sealKnown = expectedSeq === 1;
  let seal = AUDIT_GENESIS_HASH;
  let lastV1 = 0;
  let afterV2 = false;
  let sealed = false;
  let pending: number | null = null;
  let checked = 0;
  let head: AuditChainReport["head"] = null;
  for (;;) {
    const { rows } = await db.execute<ChainRow>(chainRowsFrom(expectedSeq, batchSize));
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
      if (row.hash_version === null) {
        const outcome = v1Row(row, afterV2);
        if (outcome === "erased") pending ??= seq;
        else if (outcome !== "ok") return fail(outcome);
        seal = auditSealStep(seal, row.hash, row.canonical_v2);
        lastV1 = seq;
      } else {
        const problem = v2Row(row);
        if (problem) return fail(problem);
        afterV2 = true;
        if (isUpgradeEvent(row)) {
          if (sealKnown && !sealMatches(row, seal, lastV1)) return fail("seal_mismatch");
          sealed = true;
        }
      }
      checked += 1;
      head = { seq, hash: row.hash };
      expectedSeq = seq + 1;
      expectedPrev = row.hash;
    }
    if (rows.length < batchSize) {
      if (pending !== null && !sealed) {
        return { ok: false, checked, head, problem: { seq: pending, kind: "hash_mismatch" } };
      }
      return { ok: true, checked, head };
    }
  }
}
