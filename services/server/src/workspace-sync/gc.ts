import { SYSTEM_ACTOR, sql, teams, withTeam, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import { workspaceBlobKey, type WorkspaceOwner } from "./keys.js";
import type { ObjectStore } from "./object-store.js";
import { lockWorkspace } from "./store.js";

/**
 * Collection (KOBE-27): blobs no live path references any more (older than a grace period, so an
 * upload waiting for its commit is never taken) and tombstones older than their TTL (the
 * workspace's horizon moves past them; an older `since` must resync). Three steps keep S3 and the
 * manifest consistent across crashes and concurrent uploads:
 *
 * 1. under the workspace lock: mark the candidates `deleting` (commits and uploads of that
 *    content now see it as missing / busy), purge old tombstones;
 * 2. delete the objects;
 * 3. delete the marked rows, audit `workspace.purged` (counts only).
 *
 * A crash between steps leaves rows marked `deleting`, which the next run finishes.
 */
export interface CollectOptions {
  readonly prefix: string;
  readonly blobGraceMs: number;
  readonly tombstoneTtlMs: number;
  /** Most blobs collected per workspace per run. */
  readonly batch: number;
}

export interface CollectResult {
  readonly blobs: number;
  readonly bytes: number;
  readonly tombstones: number;
}

export async function collectWorkspace(
  db: KobeDb,
  objects: ObjectStore,
  owner: WorkspaceOwner,
  options: CollectOptions,
): Promise<CollectResult> {
  const marked = await withTeam(db, owner.teamId, async (tx) => {
    await lockWorkspace(tx, owner);
    await tx.execute(sql`
      UPDATE workspace_blobs b SET deleting = true
       WHERE (b.team_id, b.user_id, b.sha256) IN (
         SELECT c.team_id, c.user_id, c.sha256 FROM workspace_blobs c
          WHERE c.team_id = ${owner.teamId} AND c.user_id = ${owner.userId} AND NOT c.deleting
            AND c.created_at < now() - make_interval(secs => ${options.blobGraceMs / 1000})
            AND NOT EXISTS (
              SELECT 1 FROM workspace_files f
               WHERE f.team_id = c.team_id AND f.user_id = c.user_id AND f.sha256 = c.sha256
                 AND NOT f.deleted)
          LIMIT ${options.batch})`);
    const rows = await tx.execute<{ sha256: string; size: string }>(sql`
      SELECT sha256, size FROM workspace_blobs
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND deleting
       LIMIT ${options.batch}`);
    const purged = await tx.execute<{ rev: string }>(sql`
      DELETE FROM workspace_files
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND deleted
         AND updated_at < now() - make_interval(secs => ${options.tombstoneTtlMs / 1000})
      RETURNING rev`);
    const maxRev = purged.rows.reduce((m, r) => Math.max(m, Number(r.rev)), 0);
    if (maxRev > 0) {
      await tx.execute(sql`
        UPDATE workspace_sync SET horizon_rev = GREATEST(horizon_rev, ${maxRev})
         WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}`);
    }
    return {
      blobs: rows.rows.map((r) => ({ sha256: r.sha256, size: Number(r.size) })),
      tombstones: purged.rows.length,
    };
  });
  if (marked.blobs.length === 0 && marked.tombstones === 0) {
    return { blobs: 0, bytes: 0, tombstones: 0 };
  }
  await objects.delete(marked.blobs.map((b) => workspaceBlobKey(options.prefix, owner, b.sha256)));
  const result = {
    blobs: marked.blobs.length,
    bytes: marked.blobs.reduce((n, b) => n + b.size, 0),
    tombstones: marked.tombstones,
  };
  await withTeam(db, owner.teamId, async (tx) => {
    if (marked.blobs.length > 0) {
      await tx.execute(sql`
        DELETE FROM workspace_blobs
         WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND deleting
           AND sha256 IN ${marked.blobs.map((b) => b.sha256)}`);
    }
    await recordAudit(tx, {
      action: "workspace.purged",
      actor: SYSTEM_ACTOR,
      teamId: owner.teamId,
      target: { userId: owner.userId, ...result },
    });
  });
  return result;
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
