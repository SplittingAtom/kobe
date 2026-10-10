import {
  BLOB_REF_COLUMNS,
  isUnderLegalHold,
  lockLegalHolds,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { ListedObject } from "../workspace-sync/object-store.js";
import { withTimeout, type BlobStore } from "./blobs.js";

/**
 * Orphaned object sweep (KOBE-189), a step of the nightly retention pass (so one replica runs it
 * at a time, under the pass's advisory lock). It deletes two kinds of leftovers of crashes:
 *
 *  - upload staging objects, `<prefix>teams/<team>/users/<user>/workspace/incoming/<uuid>`
 *    (KOBE-184: copied to the content key, then deleted; a crash in between leaves one);
 *  - fork-copied entry bodies, `<prefix>teams/<team>/threads/<id>/entries/<64 hex>` where no
 *    `threads` row has that id (KOBE-236: a crash between the copy and the commit).
 *
 * Safety: only keys of exactly those shapes inside the configured prefix are ever listed or
 * deleted (the bucket may be shared); only objects older than {@link ORPHAN_GRACE_MS}, so uploads
 * and forks in flight are never touched; never a key any registered blob column of the team
 * references (`BLOB_REF_COLUMNS`) or the release queue still holds; never under a legal hold
 * (staging: the key's user, or a team-wide hold; fork bodies have no owner, so any hold in the
 * team). The delete runs in a transaction holding the legal-hold lock shared, after those checks
 * were repeated. Listing is paged, and one sweep deletes at most {@link MAX_DELETIONS} per team.
 * Logs counts only.
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60_000;
export const MAX_DELETIONS = 1000;
/** Listing pages (of {@link PAGE_SIZE}) one sweep reads per team and listing before stopping. */
export const MAX_PAGES = 200;
const PAGE_SIZE = 1000;
const DELETE_TIMEOUT_MS = 30_000;
const BATCH = 100;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface OrphanCounts {
  /** Staging objects deleted. */
  readonly staging: number;
  /** Fork-copied entry bodies deleted. */
  readonly forks: number;
}

export interface OrphanOptions {
  readonly graceMs?: number;
  readonly maxDeletions?: number;
  readonly stop?: () => boolean;
}

interface Candidate {
  readonly key: string;
  /** Present for staging objects (the workspace owner). */
  readonly userId: string | null;
}

/** All objects under `prefix` (one level when `delimiter`), paged, at most {@link MAX_PAGES}. */
async function* pages(store: BlobStore, prefix: string, delimiter?: string) {
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await store.objects.list(prefix, {
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      ...(delimiter ? { delimiter } : {}),
    });
    yield page;
    if (page.next === undefined) return;
    cursor = page.next;
  }
}

const old = (o: ListedObject, cutoff: number) => o.lastModified.getTime() < cutoff;

async function workspaceUsers(db: KobeDb, teamId: string): Promise<string[]> {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<{ user_id: string }>(sql`
      SELECT user_id FROM team_members WHERE team_id = ${teamId}
      UNION SELECT user_id FROM workspace_files WHERE team_id = ${teamId}`);
    return res.rows.map((r) => r.user_id);
  });
}

async function stagingCandidates(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  cutoff: number,
  max: number,
  stop: () => boolean,
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const userId of await workspaceUsers(db, teamId)) {
    const prefix = `${store.prefix}teams/${teamId}/users/${userId}/workspace/incoming/`;
    const shape = new RegExp(`^${escape(prefix)}${UUID}$`);
    for await (const page of pages(store, prefix)) {
      for (const o of page.objects) {
        if (shape.test(o.key) && old(o, cutoff)) found.push({ key: o.key, userId });
      }
      if (found.length >= max || stop()) return found.slice(0, max);
    }
  }
  return found;
}

async function existingThreads(db: KobeDb, teamId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      SELECT id FROM threads WHERE team_id = ${teamId}
         AND id = ANY(ARRAY[${sql.join(
           ids.map((i) => sql`${i}`),
           sql`, `,
         )}]::uuid[])`);
    return new Set(res.rows.map((r) => r.id));
  });
}

async function forkCandidates(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  cutoff: number,
  max: number,
  stop: () => boolean,
): Promise<Candidate[]> {
  const root = `${store.prefix}teams/${teamId}/threads/`;
  const folder = new RegExp(`^${escape(root)}(${UUID})/$`);
  const found: Candidate[] = [];
  for await (const page of pages(store, root, "/")) {
    const dirs = page.prefixes.flatMap((p) => folder.exec(p)?.[1] ?? []);
    const live = await existingThreads(db, teamId, dirs);
    for (const id of dirs.filter((d) => !live.has(d))) {
      const prefix = `${root}${id}/entries/`;
      const shape = new RegExp(`^${escape(prefix)}[0-9a-f]{64}$`);
      for await (const body of pages(store, prefix)) {
        for (const o of body.objects) {
          if (shape.test(o.key) && old(o, cutoff)) found.push({ key: o.key, userId: null });
        }
        if (found.length >= max) return found.slice(0, max);
      }
    }
    if (stop()) break;
  }
  return found;
}

/** Keys among `keys` that a registered blob column of the team references or the queue holds. */
async function protectedKeys(tx: KobeTx, teamId: string, keys: string[]): Promise<Set<string>> {
  const list = sql`ARRAY[${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )}]::text[]`;
  const keep = new Set<string>();
  for (const ref of BLOB_REF_COLUMNS) {
    const res = await tx.execute<{ key: string }>(sql`
      SELECT DISTINCT x.${sql.identifier(ref.column)} AS key FROM ${sql.identifier(ref.table)} x
       WHERE x.team_id = ${teamId} AND x.${sql.identifier(ref.column)} = ANY(${list})`);
    for (const row of res.rows) keep.add(row.key);
  }
  const queued = await tx.execute<{ key: string }>(sql`
    SELECT key FROM retention_blob_deletions WHERE team_id = ${teamId} AND key = ANY(${list})`);
  for (const row of queued.rows) keep.add(row.key);
  return keep;
}

/** Deletes one batch under the shared legal-hold lock; returns how many objects went. */
async function deleteBatch(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  batch: Candidate[],
): Promise<number> {
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
    await lockLegalHolds(tx);
    const keep = await protectedKeys(
      tx,
      teamId,
      batch.map((c) => c.key),
    );
    const doomed: string[] = [];
    for (const c of batch) {
      if (keep.has(c.key)) continue;
      // Staging: the workspace owner's (or a team-wide) hold; fork bodies have no owner: any hold.
      if (await isUnderLegalHold(tx, teamId, c.userId)) continue;
      doomed.push(c.key);
    }
    if (doomed.length > 0) await withTimeout(store.objects.delete(doomed), DELETE_TIMEOUT_MS);
    return doomed.length;
  });
}

async function deleteAll(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  found: Candidate[],
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < found.length; i += BATCH) {
    deleted += await deleteBatch(db, teamId, store, found.slice(i, i + BATCH));
  }
  return deleted;
}

export const NO_ORPHANS: OrphanCounts = { staging: 0, forks: 0 };

export async function sweepOrphanObjects(
  db: KobeDb,
  teamId: string,
  store: BlobStore,
  options: OrphanOptions = {},
): Promise<OrphanCounts> {
  const cutoff = Date.now() - (options.graceMs ?? ORPHAN_GRACE_MS);
  const max = options.maxDeletions ?? MAX_DELETIONS;
  const stop = options.stop ?? (() => false);
  const staging = await deleteAll(
    db,
    teamId,
    store,
    await stagingCandidates(db, teamId, store, cutoff, max, stop),
  );
  if (stop() || staging >= max) return { staging, forks: 0 };
  const forks = await deleteAll(
    db,
    teamId,
    store,
    await forkCandidates(db, teamId, store, cutoff, max - staging, stop),
  );
  return { staging, forks };
}
