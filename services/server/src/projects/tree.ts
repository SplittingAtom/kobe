import { createHash, randomUUID } from "node:crypto";
import { sql, type KobeTx } from "@kobe/db";
import {
  canonicalJson,
  PROJECT_COMMIT_MESSAGE_MAX,
  type ProjectCommit,
  type ProjectDiffEntry,
  type ProjectTreeEntry,
} from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";

/**
 * A project's history as data (KOBE-579, Workspaces CM1): commits with a full snapshot tree each
 * (`project_tree_entries`), `projects.head_commit_id`, and `project_files` as the head tree that
 * mounts, downloads and the API read. Every write of a project's files goes through
 * {@link writeCommit}: a checkout's commit, a revert, and the single-file paths (upload, Add to
 * project, proposal, removal), so `project_files` always equals the head tree. Callers hold the
 * project row lock (`loadAccess(..., { lock: true })`). Paths, names and messages never reach the
 * audit log; ids and counts do.
 */

export interface TreeFile {
  readonly path: string;
  readonly sha256: string;
  readonly blobRef: string;
  readonly size: number;
  readonly mime: string;
  readonly executable: boolean;
}

/** A tree by path (relative to the project folder). */
export type Tree = ReadonlyMap<string, TreeFile>;

/** What a diff compares: content, size and the executable bit. */
export interface Version {
  readonly sha256: string;
  readonly size: number;
  readonly executable: boolean;
}

export interface Change {
  readonly change: "added" | "modified" | "deleted";
  readonly path: string;
  readonly before?: Version;
  readonly after?: Version;
}

export interface Head {
  readonly id: string;
  readonly seq: number;
}

export interface CommitAuthor {
  readonly userId: string;
  readonly kind: "user" | "agent";
  readonly threadId?: string | undefined;
  readonly runId?: string | undefined;
}

type EntryRow = {
  path: string;
  sha256: string;
  blob_ref: string;
  size_bytes: string | number;
  mime_type: string;
  executable: boolean;
};

const toFile = (r: EntryRow): TreeFile => ({
  path: r.path,
  sha256: r.sha256,
  blobRef: r.blob_ref,
  size: Number(r.size_bytes),
  mime: r.mime_type,
  executable: r.executable,
});

export const toTreeEntry = (f: TreeFile): ProjectTreeEntry => ({
  path: f.path,
  sha256: f.sha256,
  blob_ref: f.blobRef,
  size_bytes: f.size,
  mime_type: f.mime,
  executable: f.executable,
});

/** The project's head (null before the first commit). */
export async function headOf(tx: KobeTx, teamId: string, projectId: string): Promise<Head | null> {
  const res = await tx.execute<{ id: string; seq: number }>(sql`
    SELECT c.id, c.seq FROM projects p
      JOIN project_commits c ON c.team_id = p.team_id AND c.id = p.head_commit_id
     WHERE p.team_id = ${teamId} AND p.id = ${projectId}`);
  const row = res.rows[0];
  return row ? { id: row.id, seq: Number(row.seq) } : null;
}

/** The tree of a commit (empty for null: a project with no commit yet). */
export async function loadTree(tx: KobeTx, teamId: string, commitId: string | null): Promise<Tree> {
  if (commitId === null) return new Map();
  const res = await tx.execute<EntryRow>(sql`
    SELECT path, sha256, blob_ref, size_bytes, mime_type, executable FROM project_tree_entries
     WHERE team_id = ${teamId} AND commit_id = ${commitId} ORDER BY path`);
  return new Map(res.rows.map((r) => [r.path, toFile(r)]));
}

const same = (a: Version | undefined, b: Version | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.sha256 === b.sha256 && a.executable === b.executable;

/** Changes from `before` to `after`, sorted by path (code-point order, stable across hosts). */
export function diffVersions(
  before: ReadonlyMap<string, Version>,
  after: ReadonlyMap<string, Version>,
): Change[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const out: Change[] = [];
  for (const path of paths) {
    const b = before.get(path);
    const a = after.get(path);
    if (same(b, a)) continue;
    if (b === undefined) out.push({ change: "added", path, after: a as Version });
    else if (a === undefined) out.push({ change: "deleted", path, before: b });
    else out.push({ change: "modified", path, before: b, after: a });
  }
  return out;
}

/** The protocol's view of a diff (sizes, no hashes). */
export function toDiffEntries(changes: readonly Change[]): ProjectDiffEntry[] {
  return changes.map((c): ProjectDiffEntry => {
    if (c.change === "added") {
      return { change: "added", path: c.path, size_bytes: c.after?.size ?? 0 };
    }
    if (c.change === "deleted") {
      return { change: "deleted", path: c.path, previous_size_bytes: c.before?.size ?? 0 };
    }
    return {
      change: "modified",
      path: c.path,
      size_bytes: c.after?.size ?? 0,
      previous_size_bytes: c.before?.size ?? 0,
    };
  });
}

/**
 * SHA-256 of the sorted diff (CM6's canonical approval input): each change with its path and the
 * new content's hash, size and executable bit, so any other working copy gives another hash.
 */
export function diffHash(changes: readonly Change[]): string {
  const rows = changes.map((c) => ({
    change: c.change,
    path: c.path,
    ...(c.after === undefined
      ? {}
      : { sha256: c.after.sha256, size: c.after.size, executable: c.after.executable }),
  }));
  return createHash("sha256").update(canonicalJson(rows), "utf8").digest("hex");
}

/** `message` cut to the commit limit (single-file commits name the file). */
export function commitMessage(text: string): string {
  const trimmed = text.trim() === "" ? "Update" : text.trim();
  return [...trimmed].slice(0, PROJECT_COMMIT_MESSAGE_MAX).join("");
}

type CommitRow = {
  id: string;
  project_id: string;
  seq: number;
  parent_id: string | null;
  author_user_id: string;
  author_kind: "user" | "agent";
  thread_id: string | null;
  run_id: string | null;
  message: string;
  file_count: number;
  bytes: string | number;
  created_at: Date | string;
};

export const COMMIT_COLUMNS = sql.raw(
  `id, project_id, seq, parent_id, author_user_id, author_kind, thread_id, run_id, message,
   file_count, bytes, created_at`,
);

export const toCommit = (r: CommitRow): ProjectCommit => ({
  id: r.id,
  project_id: r.project_id,
  seq: Number(r.seq),
  parent_id: r.parent_id,
  author_user_id: r.author_user_id,
  author_kind: r.author_kind,
  thread_id: r.thread_id,
  run_id: r.run_id,
  message: r.message,
  file_count: Number(r.file_count),
  bytes: Number(r.bytes),
  created_at: new Date(r.created_at).toISOString(),
});

export type { CommitRow };

/**
 * Rewrites `project_files` to `tree`: changed paths are updated in place (same id), new ones
 * inserted, gone ones deleted. A delete under a legal hold raises KH001 (the 0078 guard), which
 * the caller turns into a refusal.
 */
async function rewriteFiles(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  tree: Tree,
  userId: string,
): Promise<void> {
  const res = await tx.execute<{ id: string; path: string; sha256: string; blob_ref: string }>(sql`
    SELECT id, path, sha256, blob_ref FROM project_files
     WHERE team_id = ${teamId} AND project_id = ${projectId}`);
  const current = new Map(res.rows.map((r) => [r.path, r]));
  const gone = [...current.values()].filter((r) => !tree.has(r.path)).map((r) => r.id);
  if (gone.length > 0) {
    await tx.execute(sql`
      DELETE FROM project_files WHERE team_id = ${teamId} AND project_id = ${projectId}
         AND id IN ${gone}`);
  }
  for (const file of tree.values()) {
    const row = current.get(file.path);
    if (row && row.sha256 === file.sha256 && row.blob_ref === file.blobRef) continue;
    if (row) {
      await tx.execute(sql`
        UPDATE project_files SET sha256 = ${file.sha256}, blob_ref = ${file.blobRef},
               size_bytes = ${file.size}, mime_type = ${file.mime}, added_by = ${userId},
               added_at = now()
         WHERE team_id = ${teamId} AND id = ${row.id}`);
    } else {
      await tx.execute(sql`
        INSERT INTO project_files
          (team_id, id, project_id, path, size_bytes, sha256, mime_type, blob_ref, source, added_by)
        VALUES (${teamId}, ${randomUUID()}, ${projectId}, ${file.path}, ${file.size},
                ${file.sha256}, ${file.mime}, ${file.blobRef}, 'upload', ${userId})`);
    }
  }
}

/**
 * Storage attributed to the project (GV2), recomputed from the trees: `live_*` = the distinct
 * objects of the head tree, `history_*` = the distinct objects only older commits reference.
 */
export async function refreshProjectStorage(
  tx: KobeTx,
  teamId: string,
  projectId: string,
): Promise<void> {
  await tx.execute(sql`
    WITH refs AS (
      SELECT e.blob_ref, max(e.size_bytes) AS size,
             bool_or(e.commit_id = p.head_commit_id) AS live
        FROM project_tree_entries e
        JOIN project_commits c ON c.team_id = e.team_id AND c.id = e.commit_id
        JOIN projects p ON p.team_id = c.team_id AND p.id = c.project_id
       WHERE c.team_id = ${teamId} AND c.project_id = ${projectId}
       GROUP BY e.blob_ref)
    UPDATE projects SET
      live_bytes = (SELECT COALESCE(sum(size), 0) FROM refs WHERE live),
      live_objects = (SELECT count(*) FROM refs WHERE live),
      history_bytes = (SELECT COALESCE(sum(size), 0) FROM refs WHERE NOT live),
      history_objects = (SELECT count(*) FROM refs WHERE NOT live)
     WHERE team_id = ${teamId} AND id = ${projectId}`);
}

export interface WrittenCommit {
  readonly commitId: string;
  readonly seq: number;
  readonly changes: readonly Change[];
}

/**
 * Writes a new head: the commit (seq = head + 1, parent = head), its whole tree, `project_files`
 * rewritten to it, the storage counters, and the queued deletion of any key it now references
 * cleared (a pre-copy reservation, {@link reserveKeys}). Audits `project.committed` unless
 * `audit` is false (a revert audits its own event). The caller holds the project row lock.
 */
export async function writeCommit(
  tx: KobeTx,
  input: {
    readonly teamId: string;
    readonly projectId: string;
    readonly tree: Tree;
    readonly author: CommitAuthor;
    readonly message: string;
    readonly audit?: boolean;
  },
): Promise<WrittenCommit> {
  const { teamId, projectId, tree, author } = input;
  const head = await headOf(tx, teamId, projectId);
  const before = await loadTree(tx, teamId, head?.id ?? null);
  const changes = diffVersions(before, tree);
  const seq = (head?.seq ?? 0) + 1;
  const files = [...tree.values()];
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO project_commits
      (team_id, project_id, seq, parent_id, author_user_id, author_kind, thread_id, run_id,
       message, file_count, bytes)
    VALUES (${teamId}, ${projectId}, ${seq}, ${head?.id ?? null}, ${author.userId}, ${author.kind},
            ${author.threadId ?? null}, ${author.runId ?? null}, ${commitMessage(input.message)},
            ${files.length}, ${bytes})
    RETURNING id`);
  const commitId = inserted.rows[0]?.id;
  if (commitId === undefined) throw new Error("project_commits insert returned no row");
  for (let i = 0; i < files.length; i += 100) {
    const batch = files.slice(i, i + 100);
    await tx.execute(sql`
      INSERT INTO project_tree_entries
        (team_id, commit_id, path, sha256, blob_ref, size_bytes, mime_type, executable)
      VALUES ${sql.join(
        batch.map(
          (f) =>
            sql`(${teamId}, ${commitId}, ${f.path}, ${f.sha256}, ${f.blobRef}, ${f.size}, ${f.mime}, ${f.executable})`,
        ),
        sql`, `,
      )}`);
  }
  await rewriteFiles(tx, teamId, projectId, tree, author.userId);
  await tx.execute(sql`
    UPDATE projects SET head_commit_id = ${commitId}, updated_at = now()
     WHERE team_id = ${teamId} AND id = ${projectId}`);
  await refreshProjectStorage(tx, teamId, projectId);
  const keys = [...new Set(files.map((f) => f.blobRef))];
  if (keys.length > 0) {
    await tx.execute(sql`
      DELETE FROM retention_blob_deletions WHERE team_id = ${teamId} AND key IN ${keys}`);
  }
  if (input.audit !== false) {
    await recordAudit(tx, {
      action: "project.committed",
      actor: { kind: "user", id: author.userId },
      teamId,
      target: {
        projectId,
        commitId,
        seq,
        authorKind: author.kind,
        ...(author.threadId === undefined ? {} : { threadId: author.threadId }),
        ...(author.runId === undefined ? {} : { runId: author.runId }),
        added: changes.filter((c) => c.change === "added").length,
        modified: changes.filter((c) => c.change === "modified").length,
        deleted: changes.filter((c) => c.change === "deleted").length,
        fileCount: files.length,
        bytes,
      },
    });
  }
  return { commitId, seq, changes };
}

/**
 * The head tree as `project_files` holds it now plus/minus one file (the single-file write
 * paths): `project_files` has no executable bit, so it is taken from the head tree.
 */
export async function filesTree(tx: KobeTx, teamId: string, projectId: string): Promise<Tree> {
  const res = await tx.execute<EntryRow>(sql`
    SELECT f.path, f.sha256, f.blob_ref, f.size_bytes, f.mime_type,
           COALESCE(e.executable, false) AS executable
      FROM project_files f
      JOIN projects p ON p.team_id = f.team_id AND p.id = f.project_id
      LEFT JOIN project_tree_entries e
        ON e.team_id = f.team_id AND e.commit_id = p.head_commit_id AND e.path = f.path
     WHERE f.team_id = ${teamId} AND f.project_id = ${projectId}`);
  return new Map(res.rows.map((r) => [r.path, toFile(r)]));
}

/** A single-file write (upload, import, proposal, removal) recorded as a commit of the new files. */
export async function commitFiles(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  author: CommitAuthor,
  message: string,
): Promise<WrittenCommit> {
  return writeCommit(tx, {
    teamId,
    projectId,
    tree: await filesTree(tx, teamId, projectId),
    author,
    message,
  });
}

/** Blob keys some tree of the project (or its head files) references, of these. */
export async function referencedKeys(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const res = await tx.execute<{ key: string }>(sql`
    SELECT e.blob_ref AS key FROM project_tree_entries e
      JOIN project_commits c ON c.team_id = e.team_id AND c.id = e.commit_id
     WHERE e.team_id = ${teamId} AND c.project_id = ${projectId} AND e.blob_ref IN ${keys}
    UNION
    SELECT blob_ref AS key FROM project_files
     WHERE team_id = ${teamId} AND project_id = ${projectId} AND blob_ref IN ${keys}`);
  return new Set(res.rows.map((r) => r.key));
}

/** How long a queued project object waits before the blob deleter may take it (GV3 grace). */
export const PROJECT_BLOB_GRACE = sql.raw(`interval '1 hour'`);

/**
 * Queues project objects for the retention blob deleter (`retention_blob_deletions`, KOBE-18):
 * `thread_id` carries the project id (the deleter only deletes keys inside that project's own
 * tree, `retention/blobs.ts`), the actor is the owner of record. Due after the grace period; the
 * deleter re-checks that nothing references the key and that no legal hold covers the team.
 */
export async function queueProjectBlobs(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  userId: string,
  keys: readonly string[],
  due: "grace" | "reservation" = "grace",
): Promise<void> {
  if (keys.length === 0) return;
  const when = due === "grace" ? PROJECT_BLOB_GRACE : sql.raw(`interval '6 hours'`);
  for (let i = 0; i < keys.length; i += 200) {
    const batch = keys.slice(i, i + 200);
    await tx.execute(sql`
      INSERT INTO retention_blob_deletions (team_id, key, thread_id, owner_user_id, enqueued_at)
      VALUES ${sql.join(
        batch.map((k) => sql`(${teamId}, ${k}, ${projectId}, ${userId}, now() + ${when})`),
        sql`, `,
      )}
      ON CONFLICT (team_id, key) DO UPDATE SET enqueued_at = EXCLUDED.enqueued_at,
        thread_id = EXCLUDED.thread_id, owner_user_id = EXCLUDED.owner_user_id`);
  }
}

/** The content-addressed key of a project blob (CM1): derived from verified ids and a hash only. */
export function projectBlobKey(
  prefix: string,
  teamId: string,
  projectId: string,
  sha256: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("project blob: not a SHA-256");
  if (!UUID.test(teamId) || !UUID.test(projectId)) {
    throw new Error("project blob: team and project must be lowercase UUIDs");
  }
  return `${prefix}teams/${teamId}/projects/${projectId}/blobs/${sha256}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `key` lies in the project's own object tree (no empty or dot segments). */
export function isProjectKey(
  prefix: string,
  teamId: string,
  projectId: string,
  key: string,
): boolean {
  if (!UUID.test(teamId) || !UUID.test(projectId)) return false;
  const tree = `${prefix}teams/${teamId}/projects/${projectId}/`;
  if (!key.startsWith(tree) || key.length > 1024) return false;
  return !key
    .slice(tree.length)
    .split("/")
    .some((p) => p === "" || p === "." || p === "..");
}
