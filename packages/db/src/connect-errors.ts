/** Network errors while the database host is unreachable or still being scheduled. */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "EHOSTUNREACH",
]);
/** Postgres is up but not accepting connections yet (starting up, recovery). */
const STARTING_SQLSTATE = "57P03";

/**
 * Whether a failed connection attempt is worth retrying. Wrong credentials, a missing database or
 * missing privileges will not fix themselves, so those fail immediately.
 */
export function isRetryableConnectError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && (NETWORK_CODES.has(code) || code === STARTING_SQLSTATE);
}
