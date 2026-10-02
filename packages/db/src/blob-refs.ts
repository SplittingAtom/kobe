/** A column holding S3 object keys (spec D15 `blob_ref`): uploads, artifacts, large tool outputs. */
export interface BlobRefColumn {
  readonly table: string;
  readonly column: string;
}

/**
 * Every column that stores an object key. `kobe backup` checks, in its Postgres snapshot, that each
 * referenced key is in the bucket listing it records, and refuses otherwise. When your table
 * stores object keys, add its column here (one line per column, in the PR that adds the column).
 */
export const BLOB_REF_COLUMNS: readonly BlobRefColumn[] = [
  { table: "thread_entries", column: "blob_ref" }, // Pi entry payloads over 64 KB (D15)
];
