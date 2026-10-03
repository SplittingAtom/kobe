import {
  isExcludedPath,
  isServerOwnedPath,
  workspacePathIssue,
  type WorkspaceChange,
  type WorkspaceChangeResult,
  type WorkspaceEntry,
} from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import { workspaceBlobKey, type WorkspaceOwner } from "./keys.js";
import type { QuotaCheck } from "./quota.js";

/**
 * The workspace manifest in Postgres (KOBE-27): `workspace_sync` (revision counter, totals),
 * `workspace_files` (one row per path, tombstones included) and `workspace_blobs` (content held in
 * the workspace's own prefix). Team tables: every function runs inside the caller's `withTeam`
 * transaction and names team and user explicitly. Every manifest write takes the
 * `workspace_sync` row lock first, which orders commits, server writes and collection of one
 * workspace across replicas.
 */

type FileRow = {
  path: string;
  rev: string;
  deleted: boolean;
  sha256: string | null;
  blob_key: string | null;
  size: string;
  mtime_ms: string;
  executable: boolean;
  origin: "sandbox" | "server";
  updated_ms: string;
};

const FILE_COLUMNS = sql.raw(
  `path, rev, deleted, sha256, blob_key, size, mtime_ms, executable, origin,
   floor(extract(epoch FROM updated_at) * 1000)::int8 AS updated_ms`,
);

export interface StoredEntry extends WorkspaceEntry {
  /** Null for tombstones. Never sent to a sandbox. */
  readonly blobKey: string | null;
}

function toEntry(r: FileRow): StoredEntry {
  return {
    path: r.path,
    rev: Number(r.rev),
    deleted: r.deleted,
    ...(r.sha256 === null ? {} : { sha256: r.sha256 }),
    size: Number(r.size),
    mtime_ms: Number(r.mtime_ms),
    executable: r.executable,
    origin: r.origin,
    updated_ms: Number(r.updated_ms),
    blobKey: r.blob_key,
  };
}

/** What a sandbox may see of an entry (no object key). */
export function publicEntry(e: StoredEntry): WorkspaceEntry {
  const { blobKey: _key, ...entry } = e;
  return entry;
}

export interface SyncState {
  readonly headRev: number;
  readonly horizonRev: number;
  readonly liveFiles: number;
  readonly liveBytes: number;
  readonly tombstones: number;
}

/** The workspace's `workspace_sync` row, created if missing, locked for this transaction. */
export async function lockWorkspace(tx: KobeTx, owner: WorkspaceOwner): Promise<SyncState> {
  await tx.execute(sql`
    INSERT INTO workspace_sync (team_id, user_id) VALUES (${owner.teamId}, ${owner.userId})
    ON CONFLICT (team_id, user_id) DO NOTHING`);
  const res = await tx.execute<{
    head_rev: string;
    horizon_rev: string;
    live_files: number;
    live_bytes: string;
    tombstones: number;
  }>(sql`
    SELECT head_rev, horizon_rev, live_files, live_bytes, tombstones FROM workspace_sync
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} FOR UPDATE`);
  const row = res.rows[0];
  if (!row) throw new Error("workspace_sync row vanished");
  return {
    headRev: Number(row.head_rev),
    horizonRev: Number(row.horizon_rev),
    liveFiles: row.live_files,
    liveBytes: Number(row.live_bytes),
    tombstones: row.tombstones,
  };
}

async function saveState(tx: KobeTx, owner: WorkspaceOwner, s: SyncState, push: boolean) {
  await tx.execute(sql`
    UPDATE workspace_sync
       SET head_rev = ${s.headRev}, horizon_rev = ${s.horizonRev}, live_files = ${s.liveFiles},
           live_bytes = ${s.liveBytes}, tombstones = ${s.tombstones}, updated_at = now()
           ${push ? sql`, last_push_at = now()` : sql``}
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}`);
}

export type ManifestPage =
  | {
      readonly kind: "page";
      readonly headRev: number;
      readonly entries: StoredEntry[];
      readonly more: boolean;
    }
  | { readonly kind: "resync_required" };

/** Entries with `rev > since`, in revision order (tombstones included; unlocked read). */
export async function manifestPage(
  tx: KobeTx,
  owner: WorkspaceOwner,
  since: number,
  limit: number,
): Promise<ManifestPage> {
  const state = await tx.execute<{ head_rev: string; horizon_rev: string }>(sql`
    SELECT head_rev, horizon_rev FROM workspace_sync
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}`);
  const headRev = Number(state.rows[0]?.head_rev ?? 0);
  const horizon = Number(state.rows[0]?.horizon_rev ?? 0);
  if (since > 0 && since < horizon) return { kind: "resync_required" };
  const rows = await tx.execute<FileRow>(sql`
    SELECT ${FILE_COLUMNS} FROM workspace_files
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND rev > ${since}
       AND rev <= ${headRev}
     ORDER BY rev LIMIT ${limit + 1}`);
  const entries = rows.rows.slice(0, limit).map(toEntry);
  return { kind: "page", headRev, entries, more: rows.rows.length > limit };
}

/** The current row of a path (live or tombstone), if any. */
export async function currentEntry(
  tx: KobeTx,
  owner: WorkspaceOwner,
  path: string,
): Promise<StoredEntry | undefined> {
  const res = await tx.execute<FileRow>(sql`
    SELECT ${FILE_COLUMNS} FROM workspace_files
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND path = ${path}`);
  const row = res.rows[0];
  return row ? toEntry(row) : undefined;
}

/** Of these hashes, the ones this workspace does not hold (or is collecting). */
export async function missingBlobs(
  tx: KobeTx,
  owner: WorkspaceOwner,
  hashes: readonly string[],
): Promise<string[]> {
  if (hashes.length === 0) return [];
  const res = await tx.execute<{ sha256: string }>(sql`
    SELECT sha256 FROM workspace_blobs
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleting
       AND sha256 IN ${[...new Set(hashes)]}`);
  const held = new Set(res.rows.map((r) => r.sha256));
  return [...new Set(hashes)].filter((h) => !held.has(h));
}

export type BlobState = "absent" | "held" | "deleting";

export async function blobState(
  tx: KobeTx,
  owner: WorkspaceOwner,
  sha256: string,
): Promise<BlobState> {
  const res = await tx.execute<{ deleting: boolean }>(sql`
    SELECT deleting FROM workspace_blobs
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND sha256 = ${sha256}`);
  const row = res.rows[0];
  if (!row) return "absent";
  return row.deleting ? "deleting" : "held";
}

export interface UploadLimits {
  /** Bytes held in the workspace's blob prefix, committed or not, plus uploads in flight. */
  readonly maxBlobBytes: number;
  /** Distinct uncommitted contents (beyond one per live file) a workspace may hold. */
  readonly maxUncommittedBlobs: number;
}

/**
 * Reserves room for an upload before its bytes are accepted (one atomic update of the
 * workspace's counters): concurrent uploads can't overshoot the byte cap, and the number of
 * distinct blobs stays within live files + `maxUncommittedBlobs`. Pair with {@link finishUpload}.
 */
export async function reserveUpload(
  tx: KobeTx,
  owner: WorkspaceOwner,
  size: number,
  limits: UploadLimits,
): Promise<boolean> {
  await tx.execute(sql`
    INSERT INTO workspace_sync (team_id, user_id) VALUES (${owner.teamId}, ${owner.userId})
    ON CONFLICT (team_id, user_id) DO NOTHING`);
  const res = await tx.execute(sql`
    UPDATE workspace_sync
       SET pending_blobs = pending_blobs + 1, pending_bytes = pending_bytes + ${size},
           pending_since = COALESCE(pending_since, now())
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
       AND blob_bytes + pending_bytes + ${size} <= ${limits.maxBlobBytes}
       AND blob_count + pending_blobs + 1 <= live_files + ${limits.maxUncommittedBlobs}
    RETURNING 1`);
  return res.rows.length > 0;
}

/**
 * Ends a reservation; when the upload was recorded as new content, its size moves into the
 * workspace's blob totals. Runs whether the upload succeeded or not.
 */
export async function finishUpload(
  tx: KobeTx,
  owner: WorkspaceOwner,
  size: number,
  added: boolean,
): Promise<void> {
  await tx.execute(sql`
    UPDATE workspace_sync
       SET pending_blobs = GREATEST(pending_blobs - 1, 0),
           pending_bytes = GREATEST(pending_bytes - ${size}, 0),
           pending_since = CASE WHEN pending_blobs <= 1 THEN NULL ELSE pending_since END,
           blob_count = blob_count + ${added ? 1 : 0},
           blob_bytes = blob_bytes + ${added ? size : 0}
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}`);
}

/**
 * After a verified upload: `added` (new content), `exists` (another upload of it won), or
 * `deleting` (a collection of that content is in progress: upload again later).
 */
export async function recordBlob(
  tx: KobeTx,
  owner: WorkspaceOwner,
  sha256: string,
  size: number,
): Promise<"added" | "exists" | "deleting"> {
  const inserted = await tx.execute(sql`
    INSERT INTO workspace_blobs (team_id, user_id, sha256, size)
    VALUES (${owner.teamId}, ${owner.userId}, ${sha256}, ${size})
    ON CONFLICT (team_id, user_id, sha256) DO NOTHING
    RETURNING 1`);
  if (inserted.rows.length > 0) return "added";
  return (await blobState(tx, owner, sha256)) === "deleting" ? "deleting" : "exists";
}

async function blobSize(tx: KobeTx, owner: WorkspaceOwner, sha256: string) {
  const res = await tx.execute<{ size: string }>(sql`
    SELECT size FROM workspace_blobs
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND sha256 = ${sha256}
       AND NOT deleting`);
  const row = res.rows[0];
  return row ? Number(row.size) : undefined;
}

interface WriteFields {
  readonly sha256: string;
  readonly blobKey: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly executable: boolean;
}

async function writeRow(
  tx: KobeTx,
  owner: WorkspaceOwner,
  path: string,
  rev: number,
  origin: "sandbox" | "server",
  fields: WriteFields | { readonly deletedSize: number; readonly deletedMtimeMs: number },
  previous: StoredEntry | undefined,
): Promise<StoredEntry> {
  const live = "sha256" in fields;
  // The content this path stops pointing at: collection's grace period starts now.
  if (previous?.sha256 !== undefined && (!live || previous.sha256 !== fields.sha256)) {
    await tx.execute(sql`
      UPDATE workspace_blobs SET released_at = now()
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
         AND sha256 = ${previous.sha256}`);
  }
  const res = await tx.execute<FileRow>(sql`
    INSERT INTO workspace_files
      (team_id, user_id, path, rev, deleted, sha256, blob_key, size, mtime_ms, executable, origin,
       updated_at)
    VALUES (${owner.teamId}, ${owner.userId}, ${path}, ${rev}, ${!live},
            ${live ? fields.sha256 : null}, ${live ? fields.blobKey : null},
            ${live ? fields.size : fields.deletedSize}, ${live ? fields.mtimeMs : fields.deletedMtimeMs},
            ${live ? fields.executable : false}, ${origin}, now())
    ON CONFLICT (team_id, user_id, path) DO UPDATE SET
      rev = EXCLUDED.rev, deleted = EXCLUDED.deleted, sha256 = EXCLUDED.sha256,
      blob_key = EXCLUDED.blob_key, size = EXCLUDED.size, mtime_ms = EXCLUDED.mtime_ms,
      executable = EXCLUDED.executable, origin = EXCLUDED.origin, updated_at = now()
    RETURNING ${FILE_COLUMNS}`);
  const row = res.rows[0];
  if (!row) throw new Error("workspace_files write returned nothing");
  return toEntry(row);
}

export interface CommitContext {
  /** Object key prefix (KOBE_S3_PREFIX). */
  readonly prefix: string;
  readonly quota: QuotaCheck;
  /** Rows (live + tombstones) per workspace. */
  readonly maxRows: number;
}

/** Tombstones purged at once when a workspace reaches its row cap (amortised). */
const COMPACT_BATCH = 1000;

/**
 * Purges the oldest tombstones now (the row cap was reached), moving the horizon past them:
 * pullers whose `since` is older resync from 0. Under the workspace lock.
 */
async function compactTombstones(
  tx: KobeTx,
  owner: WorkspaceOwner,
  state: SyncState,
  count: number,
): Promise<SyncState> {
  if (state.tombstones === 0) return state;
  const purged = await tx.execute<{ rev: string }>(sql`
    DELETE FROM workspace_files
     WHERE (team_id, user_id, path) IN (
       SELECT team_id, user_id, path FROM workspace_files
        WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND deleted
        ORDER BY rev LIMIT ${count})
    RETURNING rev`);
  const maxRev = purged.rows.reduce((m, r) => Math.max(m, Number(r.rev)), state.horizonRev);
  return {
    ...state,
    horizonRev: maxRev,
    tombstones: Math.max(0, state.tombstones - purged.rows.length),
  };
}

/**
 * Room for one more row, compacting tombstones if needed. The returned state always carries what
 * a compaction did (rows deleted, horizon moved) — callers must keep it even when `ok` is false.
 */
async function roomForRow(
  tx: KobeTx,
  owner: WorkspaceOwner,
  state: SyncState,
  maxRows: number,
): Promise<{ readonly state: SyncState; readonly ok: boolean }> {
  if (state.liveFiles + state.tombstones < maxRows) return { state, ok: true };
  const compacted = await compactTombstones(tx, owner, state, COMPACT_BATCH);
  return { state: compacted, ok: compacted.liveFiles + compacted.tombstones < maxRows };
}

/**
 * Applies a sandbox's changes (contract `commit`): per-path compare-and-set on `base_rev`, each
 * change with its own result. Server-owned and excluded areas are refused (`read_only`): what the
 * agent does there never reaches S3.
 */
export async function commitChanges(
  tx: KobeTx,
  owner: WorkspaceOwner,
  changes: readonly WorkspaceChange[],
  ctx: CommitContext,
): Promise<{ headRev: number; results: WorkspaceChangeResult[]; refused: string[] }> {
  let state = await lockWorkspace(tx, owner);
  const results: WorkspaceChangeResult[] = [];
  const refused: string[] = [];
  for (const change of changes) {
    const { path } = change;
    if (workspacePathIssue(path) !== undefined) {
      results.push({ status: "rejected", path, code: "invalid_path" });
      continue;
    }
    if (isServerOwnedPath(path) || isExcludedPath(path)) {
      results.push({ status: "rejected", path, code: "read_only" });
      continue;
    }
    const current = await currentEntry(tx, owner, path);
    const live = current !== undefined && !current.deleted;
    if (change.op === "delete") {
      if (!live) {
        results.push({ status: "noop", path });
        continue;
      }
      if (change.base_rev !== current.rev) {
        results.push({ status: "conflict", path, current: publicEntry(current) });
        continue;
      }
      const rev = state.headRev + 1;
      const entry = await writeRow(
        tx,
        owner,
        path,
        rev,
        "sandbox",
        { deletedSize: current.size, deletedMtimeMs: current.mtime_ms },
        current,
      );
      state = {
        ...state,
        headRev: rev,
        liveFiles: state.liveFiles - 1,
        liveBytes: state.liveBytes - current.size,
        tombstones: state.tombstones + 1,
      };
      results.push({ status: "applied", path, entry: publicEntry(entry) });
      continue;
    }
    // put: onto a live row only from the revision it was based on; onto a tombstone or a new path
    // always (a deletion never beats a modification).
    if (live && change.base_rev !== current.rev) {
      results.push({ status: "conflict", path, current: publicEntry(current) });
      continue;
    }
    const held = await blobSize(tx, owner, change.sha256);
    if (held === undefined) {
      results.push({ status: "rejected", path, code: "missing_blob" });
      continue;
    }
    if (held !== change.size) {
      results.push({ status: "rejected", path, code: "size_mismatch" });
      continue;
    }
    if (current === undefined) {
      // A new row: live files + tombstones are capped (churn can't grow the manifest forever).
      const room = await roomForRow(tx, owner, state, ctx.maxRows);
      state = room.state;
      if (!room.ok) {
        results.push({ status: "rejected", path, code: "too_many_files" });
        refused.push("workspace_files");
        continue;
      }
    }
    const liveFiles = state.liveFiles + (live ? 0 : 1);
    const liveBytes = state.liveBytes - (live ? current.size : 0) + change.size;
    const tombstones = state.tombstones - (current?.deleted === true ? 1 : 0);
    const decision = await ctx.quota(tx, {
      owner,
      fileBytes: change.size,
      liveFiles,
      liveBytes,
    });
    if (!decision.ok) {
      results.push({ status: "rejected", path, code: decision.code });
      refused.push(decision.limit);
      continue;
    }
    const rev = state.headRev + 1;
    const entry = await writeRow(
      tx,
      owner,
      path,
      rev,
      "sandbox",
      {
        sha256: change.sha256,
        blobKey: workspaceBlobKey(ctx.prefix, owner, change.sha256),
        size: change.size,
        mtimeMs: change.mtime_ms,
        executable: change.executable,
      },
      current,
    );
    state = { ...state, headRev: rev, liveFiles, liveBytes, tombstones };
    results.push({ status: "applied", path, entry: publicEntry(entry) });
  }
  await saveState(tx, owner, state, true);
  return { headRev: state.headRev, results, refused };
}

/**
 * Object keys a server write may point at: under this team's tree (`teams/<team>/…`, e.g. an
 * upload or a project file) and, inside `users/`, only this user's — never another tenant's.
 */
export function assertOwnedKey(prefix: string, owner: WorkspaceOwner, key: string): void {
  const team = `${prefix}teams/${owner.teamId}/`;
  const ok =
    key.startsWith(team) &&
    key.length > team.length &&
    key.length <= 1024 &&
    !key.split("/").some((part) => part === "" || part === "." || part === "..") &&
    (!key.startsWith(`${team}users/`) || key.startsWith(`${team}users/${owner.userId}/`));
  if (!ok) throw new Error("putServerFile: blobKey is not under this team's (and user's) prefix");
}

export interface ServerFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  /** Where the content is (e.g. KOBE-53's upload object, KOBE-57's project file object). */
  readonly blobKey: string;
  readonly mtimeMs?: number;
  readonly executable?: boolean;
}

/**
 * A server write into a workspace (KOBE-53 uploads into `uploads/<thread>/`, KOBE-57 project files
 * into `projects/<slug>/`, KOBE-54 file-browser uploads anywhere): a new revision with origin
 * `server`, which the sandbox pulls (before its next run, periodically, or on wake). The caller
 * owns the object at `blobKey`, checks its own limits and records its audit event in `tx`.
 */
export async function putServerFile(
  tx: KobeTx,
  owner: WorkspaceOwner,
  file: ServerFile,
  options: { readonly prefix: string; readonly maxRows?: number },
): Promise<StoredEntry> {
  const issue = workspacePathIssue(file.path);
  if (issue !== undefined || isExcludedPath(file.path)) {
    throw new Error(`putServerFile: invalid workspace path (${issue ?? "excluded area"})`);
  }
  if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error("putServerFile: sha256 must be hex");
  assertOwnedKey(options.prefix, owner, file.blobKey);
  let state = await lockWorkspace(tx, owner);
  const current = await currentEntry(tx, owner, file.path);
  const live = current !== undefined && !current.deleted;
  if (current === undefined && options.maxRows !== undefined) {
    // Server writes are the caller's to limit; only make room by compacting tombstones.
    state = (await roomForRow(tx, owner, state, options.maxRows)).state;
  }
  const rev = state.headRev + 1;
  const entry = await writeRow(
    tx,
    owner,
    file.path,
    rev,
    "server",
    {
      sha256: file.sha256,
      blobKey: file.blobKey,
      size: file.size,
      mtimeMs: file.mtimeMs ?? Date.now(),
      executable: file.executable ?? false,
    },
    current,
  );
  await saveState(
    tx,
    owner,
    {
      ...state,
      headRev: rev,
      liveFiles: state.liveFiles + (live ? 0 : 1),
      liveBytes: state.liveBytes - (live ? current.size : 0) + file.size,
      tombstones: state.tombstones - (current?.deleted === true ? 1 : 0),
    },
    false,
  );
  return entry;
}

/** A server-side delete (KOBE-54 file browser, KOBE-57 project file removal). */
export async function deleteServerFile(
  tx: KobeTx,
  owner: WorkspaceOwner,
  path: string,
): Promise<StoredEntry | undefined> {
  const state = await lockWorkspace(tx, owner);
  const current = await currentEntry(tx, owner, path);
  if (current === undefined || current.deleted) return undefined;
  const rev = state.headRev + 1;
  const entry = await writeRow(
    tx,
    owner,
    path,
    rev,
    "server",
    { deletedSize: current.size, deletedMtimeMs: current.mtime_ms },
    current,
  );
  await saveState(
    tx,
    owner,
    {
      ...state,
      headRev: rev,
      liveFiles: state.liveFiles - 1,
      liveBytes: state.liveBytes - current.size,
      tombstones: state.tombstones + 1,
    },
    false,
  );
  return entry;
}

/** Live entries under a directory prefix (KOBE-54's "last synced listing"; unlocked read). */
export async function listLive(
  tx: KobeTx,
  owner: WorkspaceOwner,
  dirPrefix: string,
  limit: number,
): Promise<StoredEntry[]> {
  const pattern = `${dirPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const res = await tx.execute<FileRow>(sql`
    SELECT ${FILE_COLUMNS} FROM workspace_files
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted
       AND path LIKE ${pattern}
     ORDER BY path LIMIT ${limit}`);
  return res.rows.map(toEntry);
}

export async function recordRestore(
  tx: KobeTx,
  owner: WorkspaceOwner,
  durationMs: number,
): Promise<void> {
  // A plain row update: never waits behind a commit's lock for long (lock_timeout).
  await tx.execute(sql`
    INSERT INTO workspace_sync (team_id, user_id) VALUES (${owner.teamId}, ${owner.userId})
    ON CONFLICT (team_id, user_id) DO NOTHING`);
  await tx.execute(sql`
    UPDATE workspace_sync SET last_restore_at = now(), last_restore_ms = ${Math.min(durationMs, 2_147_483_647)}
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}`);
}
