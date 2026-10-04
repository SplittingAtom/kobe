/** A column holding S3 object keys (spec D15 `blob_ref`): uploads, artifacts, large tool outputs. */
export interface BlobRefColumn {
  readonly table: string;
  readonly column: string;
  /**
   * The table's rows belong to a thread (`team_id`, `thread_id` → threads, ON DELETE CASCADE) and
   * are purged with it (D18, KOBE-18): before deleting threads, the purge queues this column's keys
   * for deletion from the object store. Set it for uploads, artifacts and other thread-owned blobs.
   */
  readonly thread?: true;
}

/**
 * Every column that stores an object key. `kobe backup` checks, in its Postgres snapshot, that each
 * referenced key is in the bucket listing it records, and refuses otherwise. The retention job
 * (KOBE-18) deletes a released key only when no column listed here still references it in the
 * team, so shared and deduplicated objects survive. Every listed table is a team table with
 * `team_id`; index (`team_id`, column) or keep the table small, since the job looks keys up by it.
 * When your table stores object keys, add its column here (one line per column, in the PR that
 * adds the column).
 */
export const BLOB_REF_COLUMNS: readonly BlobRefColumn[] = [
  { table: "thread_entries", column: "blob_ref", thread: true }, // Pi entry payloads over 64 KB (D15)
  { table: "workspace_files", column: "blob_key" }, // /workspace durable copy (KOBE-27)
];
