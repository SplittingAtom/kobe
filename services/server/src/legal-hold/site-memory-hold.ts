import { lockLegalHolds, sql, type KobeDb, type KobeTx } from "@kobe/db";

/**
 * The Site-wide legal hold as purges see it (v1.3 SM28, KOBE-647). Every server path that deletes
 * Site memory items or versions (the version cap's pruning, Site memory sweeps and purges) asks
 * {@link siteMemoryHeld} first and deletes nothing when it says yes, so a held Site never meets
 * the KH001 guard of migration 0225 (review M1: an edit past the cap must not fail).
 *
 * Isolation (review L2): the hold must be read with a fresh statement snapshot after the lock, which
 * READ COMMITTED gives. Under REPEATABLE READ or SERIALIZABLE the snapshot is taken at the first
 * statement (the lock wait), before an approval that commits meanwhile, so the purge would miss
 * it. Site purges therefore run in READ COMMITTED ({@link withSiteMemoryPurge}), and the check
 * refuses to answer in any other isolation level.
 */

export class SiteHoldIsolationError extends Error {
  constructor(level: string) {
    super(`Site memory purges run in READ COMMITTED, not ${level} (KOBE-647 review L2)`);
    this.name = "SiteHoldIsolationError";
  }
}

/**
 * Takes the legal-hold lock (shared; an approval waits for this transaction, or this one waits for
 * it and then sees it) and answers whether a Site-wide hold is in force. Hold the transaction open
 * for the deletes it guards.
 */
export async function siteMemoryHeld(tx: KobeTx): Promise<boolean> {
  const { rows: iso } = await tx.execute<{ level: string }>(
    sql`SELECT current_setting('transaction_isolation') AS level`,
  );
  const level = iso[0]?.level ?? "unknown";
  if (level !== "read committed") throw new SiteHoldIsolationError(level);
  await lockLegalHolds(tx);
  const { rows } = await tx.execute<{ held: boolean }>(
    sql`SELECT public.site_legal_hold_active() AS held`,
  );
  return rows[0]?.held === true;
}

export type SitePurgeOutcome<T> = { readonly held: true } | { readonly held: false; value: T };

/**
 * Runs a Site memory purge or sweep batch in one READ COMMITTED transaction, hold lock first:
 * `purge` runs only when no Site-wide hold is in force, and its deletes stay inside the lock.
 */
export function withSiteMemoryPurge<T>(
  db: KobeDb,
  purge: (tx: KobeTx) => Promise<T>,
): Promise<SitePurgeOutcome<T>> {
  return db.transaction(
    async (tx): Promise<SitePurgeOutcome<T>> => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
      if (await siteMemoryHeld(tx)) return { held: true };
      return { held: false, value: await purge(tx) };
    },
    { isolationLevel: "read committed" },
  );
}
