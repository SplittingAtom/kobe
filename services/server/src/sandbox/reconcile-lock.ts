import type pg from "pg";

export const TEAM_RECONCILE_LOCK = "kobe.team-namespace-reconcile";

/** Lets one server replica at a time run a reconcile pass. */
export interface ReconcileLock {
  /** Runs `fn` if the lock is free; `{ ran: false }` if another replica holds it. */
  runExclusive<T>(
    fn: () => Promise<T>,
  ): Promise<{ readonly ran: true; readonly value: T } | { readonly ran: false }>;
}

/**
 * Session-level Postgres advisory lock on a dedicated connection (like the retention job). If the
 * connection is lost the lock is released by Postgres and the pass finishes on its own: it is
 * idempotent, so an overlap with another replica is harmless.
 */
export function createPgReconcileLock(
  pool: Pick<pg.Pool, "connect">,
  onError: (err: unknown) => void = () => undefined,
  /** Lock name; another sweep (audit forwarding, KOBE-19) uses its own. */
  lockName: string = TEAM_RECONCILE_LOCK,
): ReconcileLock {
  return {
    async runExclusive(fn) {
      const client = await pool.connect();
      let locked = false;
      let broken = false;
      const listener = (err: Error) => {
        broken = true;
        onError(err);
      };
      client.on("error", listener);
      try {
        const res = await client.query<{ ok: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
          [lockName],
        );
        locked = res.rows[0]?.ok === true;
        if (!locked) return { ran: false };
        return { ran: true, value: await fn() };
      } finally {
        if (locked) {
          try {
            await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockName]);
          } catch (err) {
            broken = true; // closing the connection releases a session lock for sure
            onError(err);
          }
        }
        client.off("error", listener);
        client.release(broken);
      }
    },
  };
}
