import { SYSTEM_ACTOR, lockLegalHolds, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Shared eval cases in the retention pass and offboarding (KOBE-276, D18). A case is a member's
 * copy owned by the agent, so it outlives its thread; it is purged
 *  - once it is older than the team's retention window (counted from when it was shared),
 *  - with a departed member's data at offboarding (`purgeDepartedCasesInTx`, not audited on its
 *    own: it would name the sharer),
 *  - and copies kept for a hold (`agent_eval_case_history`) once no hold covers the member.
 * Never while a hold covers the member: each batch takes the legal-hold lock first and selects
 * unheld rows only (the tables' triggers back this up). Audited with counts only.
 */

const BATCH = 500;

export interface EvalCasePurgeCounts {
  readonly cases: number;
  readonly kept: number;
}

export const NO_EVAL_CASE_PURGE: EvalCasePurgeCounts = { cases: 0, kept: 0 };

type Reason = "retention" | "hold_released";

async function audited(tx: KobeTx, teamId: string, reason: Reason, rows: number) {
  if (rows === 0) return;
  await recordAudit(tx, {
    action: "retention.eval_cases_purged",
    actor: SYSTEM_ACTOR,
    teamId,
    target: { reason, rows },
  });
}

async function batches(
  db: KobeDb,
  teamId: string,
  stop: (() => boolean) | undefined,
  one: (tx: KobeTx) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (;;) {
    if (stop?.()) break;
    const n = await withTeam(db, teamId, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
      await lockLegalHolds(tx);
      return one(tx);
    });
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

/** Cases shared before `cutoff` (the team's window), unheld, then released hold copies. */
export async function purgeEvalCases(
  db: KobeDb,
  teamId: string,
  cutoff: Date | null,
  options: { readonly stop?: () => boolean } = {},
): Promise<EvalCasePurgeCounts> {
  const cases =
    cutoff === null
      ? 0
      : await batches(db, teamId, options.stop, async (tx) => {
          const res = await tx.execute(sql`
            DELETE FROM agent_eval_cases c
             WHERE c.team_id = ${teamId} AND c.id IN (
               SELECT k.id FROM agent_eval_cases k
                WHERE k.team_id = ${teamId} AND k.created_at < ${cutoff.toISOString()}
                  AND NOT public.legal_hold_covers(k.team_id, k.user_id)
                ORDER BY k.created_at, k.id LIMIT ${BATCH})`);
          const n = res.rowCount ?? 0;
          await audited(tx, teamId, "retention", n);
          return n;
        });
  const kept = await batches(db, teamId, options.stop, async (tx) => {
    const res = await tx.execute(sql`
      DELETE FROM agent_eval_case_history h
       WHERE h.team_id = ${teamId} AND h.id IN (
         SELECT k.id FROM agent_eval_case_history k
          WHERE k.team_id = ${teamId} AND NOT public.legal_hold_covers(k.team_id, k.user_id)
          ORDER BY k.id LIMIT ${BATCH})`);
    const n = res.rowCount ?? 0;
    await audited(tx, teamId, "hold_released", n);
    return n;
  });
  return { cases, kept };
}

/**
 * One batch of a departed member's shared cases, inside the offboarding step's transaction (which
 * holds the legal-hold lock and has checked the member's hold). Returns how many went.
 */
export async function purgeDepartedCasesInTx(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<number> {
  const res = await tx.execute(sql`
    DELETE FROM agent_eval_cases c
     WHERE c.team_id = ${teamId} AND c.id IN (
       SELECT k.id FROM agent_eval_cases k
        WHERE k.team_id = ${teamId} AND k.user_id = ${userId}
          AND NOT public.legal_hold_covers(k.team_id, k.user_id)
        ORDER BY k.id LIMIT ${BATCH})`);
  // Not audited: a row would tell team admins (often the agent's owner) that this member shared
  // cases, and how many (review S4). The offboarding step's own audit row covers the purge.
  return res.rowCount ?? 0;
}

export const EVAL_CASE_BATCH = BATCH;
