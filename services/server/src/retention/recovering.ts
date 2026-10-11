import { lockLegalHolds, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { logger } from "../logger.js";
import { DeleteAbortedError } from "./bounded-delete.js";

/**
 * `withTeam`, plus (KOBE-243): when a delete timed out after removing some objects, the batch's
 * transaction rolls back, so rows could still name objects that are gone. A short follow-up
 * transaction (legal-hold lock first; the recovery SQL re-checks holds) drops those rows, then the
 * error is rethrown as before.
 */
export async function withTeamRecovering<T>(
  db: KobeDb,
  teamId: string,
  fn: (tx: KobeTx) => Promise<T>,
): Promise<T> {
  try {
    return await withTeam(db, teamId, fn);
  } catch (err) {
    if (err instanceof DeleteAbortedError && err.recover) {
      const recover = err.recover;
      await withTeam(db, teamId, async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
        await lockLegalHolds(tx);
        await recover(tx);
      }).catch((recoverErr: unknown) =>
        logger.warn({ err: recoverErr, teamId }, "could not drop rows of objects already deleted"),
      );
    }
    throw err;
  }
}
