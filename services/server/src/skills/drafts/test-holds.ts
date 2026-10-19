import { lockLegalHolds, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { BlobStore } from "../../retention/blobs.js";
import { draftBundlePrefix, hashOfBundleKey } from "./test-bundle.js";

/**
 * Removing a draft's test bundles (KOBE-323 review S2, S3): never while a legal hold covers the
 * content's people. A bundle is kept while a hold covers the draft's author or any writer of its
 * files (live, or as the hold history of a deleted draft keeps them), or the owner of a test chat
 * whose run loaded that bundle (`runs.skill_refs`, source `draft`). Each decision runs under the
 * legal-hold lock, and the objects are deleted before it is released, so a hold placed meanwhile
 * waits for the delete or sees the objects still there.
 */

/** Test bundles kept per draft (the newest by store time); older ones go after each store. */
export const DRAFT_BUNDLES_KEPT = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Listed {
  readonly key: string;
  readonly lastModified: Date;
}

async function listAll(blobs: BlobStore, prefix: string): Promise<Listed[]> {
  const out: Listed[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await blobs.objects.list(prefix, cursor === undefined ? {} : { cursor });
    out.push(...page.objects);
    if (!page.next) return out;
    cursor = page.next;
  }
}

/** The hashes among `hashes` a hold keeps; every one when it covers the author or a writer. */
async function heldHashes(
  tx: KobeTx,
  teamId: string,
  draftId: string,
  hashes: readonly string[],
): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const anyHold = await tx.execute<{ held: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM legal_holds h WHERE h.team_id = ${teamId} AND h.status = 'active') AS held`);
  if (!anyHold.rows[0]?.held) return new Set();
  const people = await tx.execute<{ held: boolean }>(sql`
    SELECT (
      EXISTS (SELECT 1 FROM skill_drafts d WHERE d.team_id = ${teamId} AND d.id = ${draftId}
                AND public.legal_hold_covers(d.team_id, d.owner_user_id))
      OR EXISTS (SELECT 1 FROM skill_draft_files f WHERE f.team_id = ${teamId} AND f.draft_id = ${draftId}
                AND public.legal_hold_covers(f.team_id, f.updated_by))
      OR EXISTS (SELECT 1 FROM skill_draft_history h WHERE h.team_id = ${teamId} AND h.draft_id = ${draftId}
                AND public.legal_hold_covers(h.team_id, h.owner_user_id))
      OR EXISTS (SELECT 1 FROM skill_draft_file_history h
                  WHERE h.team_id = ${teamId} AND h.draft_id = ${draftId}
                    AND public.skill_draft_held(h.team_id, h.owner_user_id, h.written_by))
    ) AS held`);
  if (people.rows[0]?.held) return new Set(hashes);
  const testers = await tx.execute<{ hash: string }>(sql`
    SELECT DISTINCT ref ->> 'sha256' AS hash
      FROM threads t
      JOIN runs r ON r.team_id = t.team_id AND r.thread_id = t.id
      CROSS JOIN LATERAL jsonb_array_elements(r.skill_refs) AS ref
     WHERE t.team_id = ${teamId} AND t.skill_test
       AND public.legal_hold_covers(t.team_id, t.owner_user_id)
       AND ref ->> 'source' = 'draft'
       AND ref ->> 'sha256' IN (${sql.join(
         hashes.map((h) => sql`${h}`),
         sql`, `,
       )})`);
  return new Set(testers.rows.map((r) => r.hash));
}

/** Deletes `keys` of the draft's folder except those a hold keeps; how many were deleted. */
async function deleteUnheld(
  db: KobeDb,
  blobs: BlobStore,
  teamId: string,
  draftId: string,
  keys: readonly string[],
): Promise<number> {
  if (keys.length === 0) return 0;
  return withTeam(db, teamId, async (tx) => {
    await lockLegalHolds(tx);
    const hashes = [...new Set(keys.flatMap((k) => hashOfBundleKey(k) ?? []))];
    const held = await heldHashes(tx, teamId, draftId, hashes);
    const gone = keys.filter((k) => !held.has(hashOfBundleKey(k) ?? ""));
    if (gone.length > 0) await blobs.objects.delete(gone);
    return gone.length;
  });
}

/** Every test bundle of a draft, but those a hold keeps (its delete and purge). */
export async function deleteDraftBundles(
  db: KobeDb,
  blobs: BlobStore,
  teamId: string,
  draftId: string,
): Promise<number> {
  const listed = await listAll(blobs, draftBundlePrefix(blobs.prefix, teamId, draftId));
  return deleteUnheld(
    db,
    blobs,
    teamId,
    draftId,
    listed.map((o) => o.key),
  );
}

/** After a store: the draft keeps its newest {@link DRAFT_BUNDLES_KEPT} bundles (and held ones). */
export async function pruneDraftBundles(
  db: KobeDb,
  blobs: BlobStore,
  teamId: string,
  draftId: string,
): Promise<number> {
  const listed = await listAll(blobs, draftBundlePrefix(blobs.prefix, teamId, draftId));
  const older = [...listed]
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime() || (a.key < b.key ? 1 : -1))
    .slice(DRAFT_BUNDLES_KEPT)
    .map((o) => o.key);
  return deleteUnheld(db, blobs, teamId, draftId, older);
}

/**
 * The team's test bundles whose draft is gone (deleted by its author, the retention purge or the
 * departed-author sweep; or stored by a send that raced the delete): removed folder by folder,
 * holds respected. The retention job runs it per team, so a failed delete never leaves bundles
 * behind for good.
 */
export async function sweepOrphanDraftBundles(
  db: KobeDb,
  blobs: BlobStore,
  teamId: string,
  options: { readonly stop?: () => boolean } = {},
): Promise<{ readonly drafts: number }> {
  if (!UUID.test(teamId)) return { drafts: 0 };
  const root = `${blobs.prefix}skills/drafts/${teamId}/`;
  let cursor: string | undefined;
  let removed = 0;
  for (;;) {
    if (options.stop?.()) return { drafts: removed };
    const page = await blobs.objects.list(root, {
      delimiter: "/",
      ...(cursor === undefined ? {} : { cursor }),
    });
    const ids = page.prefixes
      .map((p) => p.slice(root.length).replace(/\/$/, ""))
      .filter((id) => UUID.test(id));
    const live = new Set(ids.length === 0 ? [] : await liveDrafts(db, teamId, ids));
    for (const id of ids.filter((d) => !live.has(d))) {
      if (options.stop?.()) return { drafts: removed };
      if ((await deleteDraftBundles(db, blobs, teamId, id)) > 0) removed += 1;
    }
    if (!page.next) return { drafts: removed };
    cursor = page.next;
  }
}

async function liveDrafts(db: KobeDb, teamId: string, ids: readonly string[]): Promise<string[]> {
  const res = await withTeam(db, teamId, (tx) =>
    tx.execute<{ id: string }>(sql`
      SELECT id FROM skill_drafts WHERE team_id = ${teamId} AND id IN (${sql.join(
        ids.map((i) => sql`${i}::uuid`),
        sql`, `,
      )})`),
  );
  return res.rows.map((r) => r.id);
}
