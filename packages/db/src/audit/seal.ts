import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { KobeDb } from "../client.js";
import {
  AUDIT_CHAIN_UPGRADED,
  AUDIT_GENESIS_HASH,
  auditSealStep,
  chainRowsFrom,
  type AuditChainProblem,
  type AuditChainRow,
} from "./verify.js";
import { SYSTEM_ACTOR, audit } from "./write.js";

export type AuditSealResult =
  /** No v1 rows (installed after the upgrade): nothing to seal. */
  | { readonly status: "not_needed" }
  | { readonly status: "already_sealed" }
  | { readonly status: "sealed"; readonly throughSeq: number; readonly rows: number }
  /** The v1 chain doesn't verify: not sealed, so its rows keep their IP until it is resolved. */
  | { readonly status: "broken"; readonly seq: number; readonly kind: AuditChainProblem };

const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

async function sealedAlready(db: KobeDb): Promise<boolean> {
  const { rows } = await db.execute(
    sql`SELECT 1 FROM public.audit_log WHERE action = ${AUDIT_CHAIN_UPGRADED} AND actor_kind = 'system' LIMIT 1`,
  );
  return rows.length > 0;
}

/**
 * Seals the rows chained before the v2 upgrade (KOBE-17): verifies them strictly (seq, links,
 * every v1 hash; none may be erased yet) and appends `audit.chain.upgraded { throughSeq, rows,
 * seal }` as a system event. Runs on the server, outside any migration, so a large log costs a
 * background read, not a lock. Idempotent and safe on every replica: an advisory lock and a
 * re-check make sure only one event is written. v1 rows become erasable 24 h after the event
 * (`audit_log_v1_erasable()`), once replicas of the previous release are gone. A broken v1 chain
 * is never sealed (docs/audit-log.md, "If the chain is broken").
 */
export async function sealAuditV1(db: KobeDb, batchSize = 5000): Promise<AuditSealResult> {
  if (await sealedAlready(db)) return { status: "already_sealed" };
  let seal = AUDIT_GENESIS_HASH;
  let prev = AUDIT_GENESIS_HASH;
  let next = 1;
  let rows = 0;
  for (;;) {
    const page = await db.execute<AuditChainRow>(
      chainRowsFrom(next, batchSize, sql`a.hash_version IS NULL`),
    );
    for (const row of page.rows) {
      const seq = Number(row.seq);
      if (seq !== next) return { status: "broken", seq: next, kind: "gap" };
      if (row.prev_hash !== prev) return { status: "broken", seq, kind: "prev_hash_mismatch" };
      if (row.pii_salt !== null || row.pii_commitment !== null) {
        return { status: "broken", seq, kind: "pii_mismatch" };
      }
      if (digest(row.canonical) !== row.hash)
        return { status: "broken", seq, kind: "hash_mismatch" };
      seal = auditSealStep(seal, row.hash, row.canonical_v2);
      prev = row.hash;
      next = seq + 1;
      rows += 1;
    }
    if (page.rows.length < batchSize) break;
  }
  if (rows === 0) return { status: "not_needed" };
  const throughSeq = next - 1;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('kobe.audit.seal', 0))`);
    const again = await tx.execute(
      sql`SELECT 1 FROM public.audit_log WHERE action = ${AUDIT_CHAIN_UPGRADED} AND actor_kind = 'system' LIMIT 1`,
    );
    if (again.rows.length > 0) return { status: "already_sealed" } as const;
    // The v1 rows end where v2 begins: the row after the last one read must be v2.
    const after = await tx.execute<{ v1: boolean }>(
      sql`SELECT hash_version IS NULL AS v1 FROM public.audit_log WHERE seq = ${throughSeq + 1}`,
    );
    if (after.rows[0]?.v1) return { status: "broken", seq: throughSeq + 1, kind: "gap" } as const;
    await audit(tx, {
      action: "audit.chain.upgraded",
      actor: SYSTEM_ACTOR,
      target: { throughSeq, rows, seal },
    });
    return { status: "sealed", throughSeq, rows } as const;
  });
}
