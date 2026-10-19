/** A column holding S3 object keys (spec D15 `blob_ref`): uploads, artifacts, large tool outputs. */
export interface BlobRefColumn {
  readonly table: string;
  readonly column: string;
  /**
   * The table's rows belong to a thread (`team_id`, `thread_id` → threads, ON DELETE CASCADE) and
   * are purged with it (D18, KOBE-18): before deleting threads, the purge queues this column's keys
   * for deletion from the object store. Set it for uploads, artifacts and other thread-owned blobs,
   * and store their objects under the thread's own tree, `<prefix>teams/<team>/threads/<thread>/`:
   * export reads and retention deletes nothing else for a thread.
   */
  readonly thread?: true;
  /**
   * A site-wide table without `team_id` (a member's personal skills, KOBE-423): backups check its
   * keys like any other; the team-scoped retention sweeps never look at it (its objects live
   * under `<prefix>users/<user>/`, outside every team tree).
   */
  readonly site?: true;
}

/**
 * Every column that stores an object key. `kobe backup` checks, in its Postgres snapshot, that each
 * referenced key is in the bucket listing it records, and refuses otherwise. Every listed table is
 * a team table with `team_id`, unless marked `site`. The retention job (KOBE-18) deletes only keys in a purged thread's
 * own tree (`<prefix>teams/<team>/threads/<thread>/`), and only when no `thread: true` column of
 * the team still references them (another thread's rows, e.g. a fork), so shared and deduplicated
 * thread objects survive; it never looks at the other columns (their keys can't be in a thread
 * tree). Index `thread: true` columns on (`team_id`, column): the job looks keys up by them.
 * When your table stores object keys, add its column here (one line per column, in the PR that
 * adds the column).
 */
export const BLOB_REF_COLUMNS: readonly BlobRefColumn[] = [
  { table: "thread_entries", column: "blob_ref", thread: true }, // Pi entry payloads over 64 KB (D15)
  { table: "artifact_versions", column: "blob_ref", thread: true }, // artifact content (KOBE-129)
  { table: "files", column: "blob_ref", thread: true }, // uploads and shared files (KOBE-142)
  { table: "thread_app_results", column: "blob_ref", thread: true }, // MCP Apps results (KOBE-438)
  { table: "memory_doc_versions", column: "blob_ref" }, // memory file content (KOBE-154); not a thread tree
  { table: "project_files", column: "blob_ref" }, // project file content (KOBE-160); not a thread tree
  { table: "workspace_files", column: "blob_key" }, // /workspace durable copy (KOBE-27)
  { table: "workspace_file_hold_history", column: "blob_key" }, // a hold's copy of moved files (KOBE-304)
  { table: "team_skill_versions", column: "storage_key" }, // team skill runtime zip (KOBE-78, 310)
  { table: "team_skill_versions", column: "package_storage_key" }, // its package zip (KOBE-310)
  { table: "personal_skill_versions", column: "storage_key", site: true }, // personal skill (KOBE-79)
  { table: "personal_skill_versions", column: "package_storage_key", site: true }, // (KOBE-310)
  { table: "registry_versions", column: "runtime_storage_key", site: true }, // catalog runtime zip (KOBE-317)
  { table: "registry_versions", column: "package_storage_key", site: true }, // its package zip (KOBE-317)
  { table: "skill_eval_runs", column: "bundle_key" }, // an eval's runtime zip (KOBE-325); its own tree
  { table: "skill_eval_runs", column: "fixtures_key" }, // its fixtures zip, same tree (KOBE-325)
];
