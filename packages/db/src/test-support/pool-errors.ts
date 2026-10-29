import pg from "pg";

export type PoolErrorLog = (message: string, err: unknown) => void;

const defaultLog: PoolErrorLog = (message, err) => {
  const code = (err as { code?: unknown } | null)?.code;
  console.warn(`${message}${typeof code === "string" ? ` (${code})` : ""}:`, String(err));
};

/** FATAL 57P01: the backend was terminated (pg_terminate_backend, DROP DATABASE WITH (FORCE)). */
const ADMIN_SHUTDOWN = "57P01";

function isAdminShutdown(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === ADMIN_SHUTDOWN;
}

/**
 * Tests only (KOBE-507): pg-pool re-emits an idle client's error (e.g. FATAL 57P01 when a test
 * drops a database WITH (FORCE) or terminates a backend) as the pool's 'error' event. A pool
 * without an 'error' listener then throws from the socket handler, which vitest reports as an
 * unhandled error that fails the run. Installed, a 57P01 (terminated by an administrator command)
 * goes to `log` instead; any other error still throws, so a genuinely lost connection stays
 * visible. Pools with their own listener are unaffected.
 * Returns a function that uninstalls it.
 */
export function installPoolErrorLogger(log: PoolErrorLog = defaultLog): () => void {
  const proto = pg.Pool.prototype as {
    emit: (event: string | symbol, ...args: unknown[]) => boolean;
  };
  const original = proto.emit;
  proto.emit = function emit(this: pg.Pool, event, ...args) {
    if (event === "error" && this.listenerCount("error") === 0 && isAdminShutdown(args[0])) {
      log("idle pg pool client failed; dropped by the pool", args[0]);
      return true;
    }
    return original.call(this, event, ...args);
  };
  return () => {
    proto.emit = original;
  };
}
