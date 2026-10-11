import type { ObjectStore } from "../workspace-sync/object-store.js";

/** Longest one batch's object delete may take while the legal-hold lock is held. */
export const DELETE_TIMEOUT_MS = 30_000;
/** After the abort, how long a store may take to settle before we stop waiting for it. */
export const SETTLE_GRACE_MS = 10_000;

/**
 * The delete timed out and was aborted (KOBE-243). `deleted` are the keys the store confirmed
 * gone, `aborted` the rest (they may or may not exist; a retry deletes them again, which is
 * harmless). `unsettled`: the store ignored the abort and was still running when we gave up.
 */
export class DeleteAbortedError extends Error {
  constructor(
    readonly deleted: readonly string[],
    readonly aborted: readonly string[],
    readonly unsettled: boolean,
    ms: number,
  ) {
    super(
      `object store delete timed out after ${ms} ms (${deleted.length} deleted, ${aborted.length} aborted${
        unsettled ? ", store did not settle" : ""
      })`,
    );
    this.name = "DeleteAbortedError";
  }
}

const confirmed = (err: unknown, keys: readonly string[]): readonly string[] => {
  const list =
    err !== null && typeof err === "object" ? (err as { deleted?: unknown }).deleted : undefined;
  return Array.isArray(list) ? keys.filter((k) => list.includes(k)) : [];
};

const sleep = (ms: number) =>
  new Promise<"timer">((resolve) => {
    setTimeout(() => resolve("timer"), ms).unref?.();
  });

/**
 * Deletes `keys`, bounded by `ms`. On timeout the store's in-flight calls are aborted through an
 * AbortSignal and this waits until they have settled (or `graceMs` passes) before rejecting with
 * {@link DeleteAbortedError}, so the caller's transaction, which holds the legal-hold lock, is
 * never released while a delete can still complete. Missing keys are fine, so retries are
 * idempotent. A store failure other than the timeout is rethrown unchanged.
 */
export async function deleteBounded(
  objects: ObjectStore,
  keys: readonly string[],
  ms: number = DELETE_TIMEOUT_MS,
  graceMs: number = SETTLE_GRACE_MS,
): Promise<{ readonly deleted: readonly string[] }> {
  const controller = new AbortController();
  const call = objects.delete(keys, { signal: controller.signal }).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const first = await Promise.race([call, sleep(ms)]);
  if (first !== "timer") {
    if (first.ok) return { deleted: keys };
    throw first.error;
  }
  controller.abort();
  const settled = await Promise.race([call, sleep(graceMs)]);
  const error = settled !== "timer" && !settled.ok ? settled.error : undefined;
  const done = settled !== "timer" && settled.ok ? keys : confirmed(error, keys);
  throw new DeleteAbortedError(
    done,
    keys.filter((k) => !done.includes(k)),
    settled === "timer",
    ms,
  );
}
