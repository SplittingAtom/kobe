import { withSpan, type Attributes } from "@kobe/telemetry";

/**
 * Child spans of a workspace write (KOBE-529) that split its time between the object store and
 * Postgres, under the route's `http.route` server span (KOBE-525):
 *
 * - `workspace.s3_put`: one object-store call (`stream` an upload's body to staging, `copy`
 *   staging to the content key, `put` a save's or a sandbox blob's bytes, `delete` staging).
 *   A `stream` also spans receiving the request body, so a slow client shows up there.
 * - `workspace.reserve_tx`: a read-only check or the upload reservation transaction.
 * - `workspace.blob_tx`: recording the stored blob and ending its reservation.
 * - `workspace.manifest_tx`: the manifest/team transaction (workspace lock, quotas, the file row,
 *   the audit event) of an upload or a save.
 * - `workspace.lock_wait`: the wait for a lock inside that transaction (`workspace` row lock or
 *   the team's `team_storage` advisory lock, the latter with the team quota read).
 *
 * Attributes are low-cardinality only: the write kind, the S3 operation, the lock, an outcome
 * from a fixed set; never ids, paths or content. A thrown failure carries only its error type.
 */
export const WRITE_SPAN = {
  s3Put: "workspace.s3_put",
  reserveTx: "workspace.reserve_tx",
  blobTx: "workspace.blob_tx",
  manifestTx: "workspace.manifest_tx",
  lockWait: "workspace.lock_wait",
} as const;

export type WriteTxSpanName =
  typeof WRITE_SPAN.reserveTx | typeof WRITE_SPAN.blobTx | typeof WRITE_SPAN.manifestTx;

export const WRITE_ATTR = {
  kind: "kobe.workspace.write",
  s3Op: "kobe.workspace.s3_op",
  lock: "kobe.workspace.lock",
  outcome: "kobe.workspace.outcome",
} as const;

/** Which write: a browser upload, a rail drop, an artifact copy, an editor save, a sandbox blob. */
export type WriteKind = "upload" | "drop" | "artifact" | "save" | "blob";
export type S3Op = "stream" | "copy" | "put" | "delete";
export type WriteLock = "workspace" | "team_storage";

/** Outcomes are code words (`reserved`, `quota_exceeded` …); anything else is `other`. */
const OUTCOME = /^[a-z_]{1,32}$/;

function outcomeAttribute(value: string | undefined): string {
  return value !== undefined && OUTCOME.test(value) ? value : "other";
}

/** One object-store call of a write. */
export function s3PutSpan<T>(kind: WriteKind, op: S3Op, fn: () => Promise<T>): Promise<T> {
  return withSpan(
    WRITE_SPAN.s3Put,
    { attributes: { [WRITE_ATTR.kind]: kind, [WRITE_ATTR.s3Op]: op } },
    () => fn(),
  );
}

/** A write's transaction; `outcome` names its result (a thrown one is `error`). */
export function writeTxSpan<T>(
  name: WriteTxSpanName,
  kind: WriteKind,
  fn: () => Promise<T>,
  outcome: (result: T) => string | undefined,
): Promise<T> {
  return withSpan(name, { attributes: { [WRITE_ATTR.kind]: kind } }, async (span) => {
    try {
      const result = await fn();
      span.setAttribute(WRITE_ATTR.outcome, outcomeAttribute(outcome(result)));
      return result;
    } catch (err) {
      span.setAttribute(WRITE_ATTR.outcome, "error");
      throw err;
    }
  });
}

/** The wait for one lock inside a write's transaction. */
export function lockWaitSpan<T>(
  kind: WriteKind,
  lock: WriteLock,
  fn: () => Promise<T>,
): Promise<T> {
  const attributes: Attributes = { [WRITE_ATTR.kind]: kind, [WRITE_ATTR.lock]: lock };
  return withSpan(WRITE_SPAN.lockWait, { attributes }, () => fn());
}
