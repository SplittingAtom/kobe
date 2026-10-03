/** Network errors while the database host is unreachable or still being scheduled. */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "EHOSTUNREACH",
]);
/**
 * node-postgres' own connect timeouts carry no error code: pg.Client's `connectionTimeoutMillis`
 * and pg.Pool's `connectionTimeoutMillis`. They mean no answer at all (e.g. a dropped SYN while a
 * new pod's network policy is not applied yet), which is as transient as a refused connection.
 */
const PG_CONNECT_TIMEOUTS = new Set(["timeout expired", "timeout exceeded when trying to connect"]);
/** Postgres is starting, shutting down for failover, or out of connection slots. */
const TRANSIENT_SQLSTATES = new Set(["57P01", "57P02", "57P03", "53300"]);

/**
 * Whether a failed connection attempt is worth retrying. Wrong credentials, a missing database or
 * missing privileges will not fix themselves, so those fail immediately.
 */
export function isRetryableConnectError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") return NETWORK_CODES.has(code) || TRANSIENT_SQLSTATES.has(code);
  return err instanceof Error && PG_CONNECT_TIMEOUTS.has(err.message);
}
