/**
 * Reading Postgres errors (SQLSTATE and constraint) from whatever reached the caller: node-postgres
 * raises a `DatabaseError`, and Drizzle wraps it as the `cause` of its own error. One helper, so
 * every "is this a lock timeout / this constraint" check reads the chain the same way.
 */

/** Postgres SQLSTATEs Kobe reacts to by name. */
export const PG_LOCK_NOT_AVAILABLE = "55P03";
export const PG_DEADLOCK_DETECTED = "40P01";
export const PG_FOREIGN_KEY_VIOLATION = "23503";

interface PgErrorFields {
  readonly code: string;
  readonly constraint: string | undefined;
}

/** How deep the `cause` chain is followed. */
const MAX_DEPTH = 5;

/** The first Postgres error (a five-character SQLSTATE) in `err` or its causes. */
export function pgErrorOf(err: unknown): PgErrorFields | undefined {
  for (let e: unknown = err, depth = 0; e && depth < MAX_DEPTH; depth += 1) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, constraint: typeof constraint === "string" ? constraint : undefined };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The SQLSTATE of the first Postgres error in `err` or its causes. */
export function pgCodeOf(err: unknown): string | undefined {
  return pgErrorOf(err)?.code;
}

/** `lock_timeout` expired (55P03). */
export function isLockTimeout(err: unknown): boolean {
  return pgCodeOf(err) === PG_LOCK_NOT_AVAILABLE;
}

/**
 * A lock wait that timed out (55P03) or a deadlock victim (40P01): the transaction rolled back
 * whole, so running it again later is safe.
 */
export function isLockConflict(err: unknown): boolean {
  const code = pgCodeOf(err);
  return code === PG_LOCK_NOT_AVAILABLE || code === PG_DEADLOCK_DETECTED;
}

/** A foreign-key violation (23503) on `constraint`. */
export function isForeignKeyViolation(err: unknown, constraint: string): boolean {
  const pg = pgErrorOf(err);
  return pg?.code === PG_FOREIGN_KEY_VIOLATION && pg.constraint === constraint;
}
