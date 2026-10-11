import { sql } from "@kobe/db";
import type { KobeDb } from "@kobe/db";

/**
 * Serializes the cap checks and activations of one user (KOBE-173): an in-process queue per user
 * and a cap on concurrent holders, then a transaction-scoped advisory lock `pg_advisory_xact_lock`
 * (across replicas) held by an outer transaction that touches no table. `fn` runs its own
 * `withTeam()` transactions inside; they commit before the lock is released.
 *
 * Each holder keeps one pooled connection for the lock and needs another for `fn`'s work, so the
 * in-process limits keep waiting requests from taking the whole pool (default 10) and starving the
 * holders: at most `MAX_HOLDERS` hold the lock connection at once, and one per user.
 */
const MAX_HOLDERS = 4;
const queues = new Map<string, Promise<unknown>>();
const waiting: (() => void)[] = [];
let holders = 0;

async function acquireSlot(): Promise<void> {
  if (holders < MAX_HOLDERS) {
    holders += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else holders -= 1;
}

export async function withUserScheduleLock<T>(
  db: KobeDb,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(userId) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      await acquireSlot();
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.schedules:${userId}`}, 0))`,
          );
          return fn();
        });
      } finally {
        releaseSlot();
      }
    });
  queues.set(userId, run);
  try {
    return await run;
  } finally {
    if (queues.get(userId) === run) queues.delete(userId);
  }
}
