import { Zip, ZipDeflate, strToU8 } from "fflate";
import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import {
  PROJECT_HISTORY_PAGE_DEFAULT,
  type ProjectCommitDetail,
  type ProjectHistoryResponse,
} from "@kobe/protocol";
import { logger } from "../logger.js";
import type { BlobStore } from "../retention/blobs.js";
import {
  COMMIT_COLUMNS,
  diffVersions,
  isProjectKey,
  loadTree,
  toCommit,
  toDiffEntries,
  toTreeEntry,
  type CommitRow,
  type TreeFile,
} from "./tree.js";

/**
 * CM7 history (KOBE-579): the commit list (newest first, paged by seq), one commit's tree and its
 * diff to its parent, a file at a commit, and the head as a zip (GV5). Readers may use all of it
 * (`view`); the routes check access first, so a restricted project answers 404 to non-members.
 */

export async function historyPage(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  before: number | undefined,
  limit: number = PROJECT_HISTORY_PAGE_DEFAULT,
): Promise<ProjectHistoryResponse> {
  const res = await tx.execute<CommitRow>(sql`
    SELECT ${COMMIT_COLUMNS} FROM project_commits
     WHERE team_id = ${teamId} AND project_id = ${projectId}
       ${before === undefined ? sql`` : sql`AND seq < ${before}`}
     ORDER BY seq DESC LIMIT ${limit + 1}`);
  const commits = res.rows.slice(0, limit).map(toCommit);
  const more = res.rows.length > limit;
  return { commits, next_before: more ? (commits.at(-1)?.seq ?? null) : null };
}

async function commitAt(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  seq: number,
): Promise<CommitRow | undefined> {
  const res = await tx.execute<CommitRow>(sql`
    SELECT ${COMMIT_COLUMNS} FROM project_commits
     WHERE team_id = ${teamId} AND project_id = ${projectId} AND seq = ${seq}`);
  return res.rows[0];
}

/** The commit, its tree and the diff to its parent (all added when the parent was pruned). */
export async function commitDetail(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  seq: number,
): Promise<ProjectCommitDetail | undefined> {
  const row = await commitAt(tx, teamId, projectId, seq);
  if (!row) return undefined;
  const tree = await loadTree(tx, teamId, row.id);
  const parent = await loadTree(tx, teamId, row.parent_id);
  return {
    commit: toCommit(row),
    tree: [...tree.values()].map(toTreeEntry),
    diff: toDiffEntries(diffVersions(parent, tree)).slice(0, 1000),
  };
}

/** One file of a commit's tree, or undefined (no such commit or path). */
export async function fileAt(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  seq: number,
  path: string,
): Promise<TreeFile | undefined> {
  const row = await commitAt(tx, teamId, projectId, seq);
  if (!row) return undefined;
  return (await loadTree(tx, teamId, row.id)).get(path);
}

/** Whether a tree's object may be served for this project (its own tree only, never elsewhere). */
export function servable(
  blobs: BlobStore,
  teamId: string,
  projectId: string,
  key: string,
): boolean {
  return isProjectKey(blobs.prefix, teamId, projectId, key);
}

/**
 * The head tree as a zip (GV5: "a project owner can download the head"), streamed file by file:
 * `<slug>/<path>` plus nothing else. A missing object is left out (logged), as the export does.
 */
export async function* headZip(
  db: KobeDb,
  blobs: BlobStore,
  teamId: string,
  projectId: string,
  slug: string,
): AsyncGenerator<Uint8Array> {
  const out: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, data) => {
    if (err) failure = err;
    else out.push(data);
  });
  const drain = function* () {
    if (failure) throw failure;
    while (out.length > 0) yield out.shift() as Uint8Array;
  };
  const tree = await withTeam(db, teamId, async (tx) => {
    const head = await tx.execute<{ head_commit_id: string | null }>(sql`
      SELECT head_commit_id FROM projects WHERE team_id = ${teamId} AND id = ${projectId}`);
    return loadTree(tx, teamId, head.rows[0]?.head_commit_id ?? null);
  });
  for (const f of tree.values()) {
    if (!servable(blobs, teamId, projectId, f.blobRef)) continue;
    const object = await blobs.objects.get(f.blobRef).catch((err: unknown) => {
      logger.warn({ err, teamId }, "project download: file unreadable");
      return null;
    });
    if (!object) continue;
    const entry = new ZipDeflate(`${slug}/${f.path}`, { level: 6 });
    entry.mtime = new Date();
    zip.add(entry);
    for await (const chunk of object.body) {
      entry.push(new Uint8Array(chunk as Buffer));
      yield* drain();
    }
    entry.push(new Uint8Array(0), true);
    yield* drain();
  }
  if (tree.size === 0) {
    const empty = new ZipDeflate(`${slug}/README.txt`, { level: 6 });
    zip.add(empty);
    empty.push(strToU8("This project has no files yet.\n"), true);
  }
  zip.end();
  yield* drain();
}
