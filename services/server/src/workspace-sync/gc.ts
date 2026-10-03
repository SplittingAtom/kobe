import { SYSTEM_ACTOR, sql, teams, withTeam, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import { workspaceBlobKey, type WorkspaceOwner } from "./keys.js";
import type { ObjectStore } from "./object-store.js";
import { lockWorkspace } from "./store.js";

/**
 * Collection (KOBE-27): blobs no live path references any more and tombstones older than their
 * TTL. A blob's grace period runs from when the last path stopped pointing at it
 * (`released_at`), or from its upload if it was never committed — so a reader that resolved an
 * entry just before an overwrite (file download, `shareFile`) still finds the object. Three steps
 * keep S3 and the manifest consistent across crashes and concurrent uploads:
 *
 * 1. under the workspace lock: mark a batch of candidates `deleting` (commits and uploads of that
 *    content now see it as missing / busy), purge a batch of old tombstones;
 * 2. delete the objects;
 * 3. delete the marked rows.
 *
 * Batches repeat until the workspace is drained or the time budget is spent (the next run goes
 * on). Then the workspace's counters are recomputed from the rows (self-healing) and
 * reservations older than any possible upload are cleared; `workspace.purged` records counts.
 */
export interface CollectOptions {
  readonly prefix: string;
  readonly blobGraceMs: number;
  readonly tombstoneTtlMs: number;
  /** Blobs per batch (tombstones: ten times as many). */
  readonly batch: number;
  /** Time spent on one workspace per run before moving on. */
  readonly budgetMs: number;
}

export interface CollectResult {
  readonly blobs: number;
  readonly bytes: number;
  readonly tombstones: number;
}

/** Uploads can't run longer than the sandbox listener's request timeout (1 h). */
const STALE_RESERVATION = "2 hours";

async function collectBatch(
  db: KobeDb,
  objects: ObjectStore,
  owner: WorkspaceOwner,
  options: CollectOptions,
): Promise<{ blobs: { sha256: string; size: number }[]; tombstones: number }> {
  const marked = await withTeam(db, owner.teamId, async (tx) => {
    await lockWorkspace(tx, owner);
    await tx.execute(sql`
      UPDATE workspace_blobs b SET deleting = true
       WHERE (b.team_id, b.user_id, b.sha256) IN (
         SELECT c.team_id, c.user_id, c.sha256 FROM workspace_blobs c
          WHERE c.team_id = ${owner.teamId} AND c.user_id = ${owner.userId} AND NOT c.deleting
            AND GREATEST(c.created_at, COALESCE(c.released_at, c.created_at))
                < now() - make_interval(secs => ${options.blobGraceMs / 1000})
            AND NOT EXISTS (
              SELECT 1 FROM workspace_files f
               WHERE f.team_id = c.team_id AND f.user_id = c.user_id AND f.sha256 = c.sha256
                 AND NOT f.deleted)
          LIMIT ${options.batch})`);
    const rows = await tx.execute<{ sha256: string; size: string }>(sql`
      SELECT sha256, size FROM workspace_blobs
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND deleting
       LIMIT ${options.batch}`);
    // Oldest first (revisions grow with time, so the horizon stays exact).
    const purged = await tx.execute<{ rev: string }>(sql`
      DELETE FROM workspace_files
       WHERE (team_id, user_id, path) IN (
         SELECT team_id, user_id, path FROM workspace_files
          WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND deleted
            AND updated_at < now() - make_interval(secs => ${options.tombstoneTtlMs / 1000})
          ORDER BY rev LIMIT ${options.batch * 10})
      RETURNING rev`);
    const maxRev = purged.rows.reduce((m, r) => Math.max(m, Number(r.rev)), 0);
    if (purged.rows.length > 0) {
      await tx.execute(sql`
        UPDATE workspace_sync
           SET horizon_rev = GREATEST(horizon_rev, ${maxRev}),
               tombstones = GREATEST(tombstones - ${purged.rows.length}, 0)
         WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}`);
    }
    return {
      blobs: rows.rows.map((r) => ({ sha256: r.sha256, size: Number(r.size) })),
      tombstones: purged.rows.length,
    };
  });
  if (marked.blobs.length === 0) return marked;
  await objects.delete(marked.blobs.map((b) => workspaceBlobKey(options.prefix, owner, b.sha256)));
  await withTeam(db, owner.teamId, async (tx) => {
    const gone = await tx.execute<{ size: string }>(sql`
      DELETE FROM workspace_blobs
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND deleting
         AND sha256 IN ${marked.blobs.map((b) => b.sha256)}
      RETURNING size`);
    // Room for new uploads at once (the exact recompute follows at the end of the run).
    const bytes = gone.rows.reduce((n, r) => n + Number(r.size), 0);
    await tx.execute(sql`
      UPDATE workspace_sync
         SET blob_count = GREATEST(blob_count - ${gone.rows.length}, 0),
             blob_bytes = GREATEST(blob_bytes - ${bytes}, 0)
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}`);
  });
  return marked;
}

export async function collectWorkspace(
  db: KobeDb,
  objects: ObjectStore,
  owner: WorkspaceOwner,
  options: CollectOptions,
): Promise<CollectResult> {
  const deadline = Date.now() + options.budgetMs;
  const total = { blobs: 0, bytes: 0, tombstones: 0 };
  try {
    for (;;) {
      const batch = await collectBatch(db, objects, owner, options);
      total.blobs += batch.blobs.length;
      total.bytes += batch.blobs.reduce((n, b) => n + b.size, 0);
      total.tombstones += batch.tombstones;
      const drained = batch.blobs.length < options.batch && batch.tombstones < options.batch * 10;
      if (drained || Date.now() >= deadline) break;
    }
  } finally {
    // Also after a failed batch (e.g. storage down): counters stay exact.
    await reconcile(db, owner, total);
  }
  return total;
}

async function reconcile(db: KobeDb, owner: WorkspaceOwner, total: CollectResult): Promise<void> {
  await withTeam(db, owner.teamId, async (tx) => {
    await lockWorkspace(tx, owner);
    // Counters from the rows themselves; reservations no upload can still hold are dropped.
    await tx.execute(sql`
      UPDATE workspace_sync s SET
        blob_count = (SELECT count(*) FROM workspace_blobs b
                       WHERE b.team_id = s.team_id AND b.user_id = s.user_id),
        blob_bytes = (SELECT coalesce(sum(size), 0) FROM workspace_blobs b
                       WHERE b.team_id = s.team_id AND b.user_id = s.user_id),
        tombstones = (SELECT count(*) FROM workspace_files f
                       WHERE f.team_id = s.team_id AND f.user_id = s.user_id AND f.deleted),
        pending_blobs = CASE WHEN s.pending_since < now() - ${STALE_RESERVATION}::interval
                             THEN 0 ELSE s.pending_blobs END,
        pending_bytes = CASE WHEN s.pending_since < now() - ${STALE_RESERVATION}::interval
                             THEN 0 ELSE s.pending_bytes END,
        pending_since = CASE WHEN s.pending_since < now() - ${STALE_RESERVATION}::interval
                             THEN NULL ELSE s.pending_since END
       WHERE s.team_id = ${owner.teamId} AND s.user_id = ${owner.userId}`);
    if (total.blobs > 0 || total.tombstones > 0) {
      await recordAudit(tx, {
        action: "workspace.purged",
        actor: SYSTEM_ACTOR,
        teamId: owner.teamId,
        target: { userId: owner.userId, ...total },
      });
    }
  });
}

/** One collection pass over every workspace of every team. Failures are per workspace. */
export async function collectAll(
  db: KobeDb,
  objects: ObjectStore,
  options: CollectOptions,
  log: Pick<Logger, "error" | "info">,
): Promise<CollectResult> {
  const all = await db.select({ id: teams.id }).from(teams);
  const total = { blobs: 0, bytes: 0, tombstones: 0 };
  for (const team of all) {
    const owners = await withTeam(db, team.id, (tx) =>
      tx.execute<{ user_id: string }>(sql`
        SELECT user_id FROM workspace_sync WHERE team_id = ${team.id}`),
    );
    for (const { user_id: userId } of owners.rows) {
      try {
        const r = await collectWorkspace(db, objects, { teamId: team.id, userId }, options);
        total.blobs += r.blobs;
        total.bytes += r.bytes;
        total.tombstones += r.tombstones;
      } catch (err) {
        log.error({ err, team_id: team.id, user_id: userId }, "workspace collection failed");
      }
    }
  }
  if (total.blobs > 0 || total.tombstones > 0) log.info(total, "workspace collection");
  return total;
}
