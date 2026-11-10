import { sql, withTeam, type KobeDb } from "@kobe/db";
import type { ProjectCommit } from "@kobe/protocol";
import { logger } from "../logger.js";
import { viewableBy } from "../projects/access.js";
import {
  COMMIT_COLUMNS,
  isProjectKey,
  loadTree,
  toCommit,
  type CommitRow,
} from "../projects/tree.js";
import type { BlobStore } from "./blobs.js";

/**
 * The export's projects (KOBE-579, Workspaces GV5). The retention export is member-scoped (the
 * caller's own threads in the active workspace; Kobe has no workspace-wide export), so it carries
 * every project the member may read (`viewableBy`: every project of the workspace, RV1): its commit list (metadata only) and its head tree's files.
 * History files stay in the product (`GET /v1/projects/{id}/commits/{seq}/files/…`). Object keys
 * are served only from the project's own tree.
 */

const HISTORY_MAX = 1000;

export interface ExportedProject {
  readonly slug: string;
  readonly meta: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly head_seq: number | null;
    readonly commits: readonly ProjectCommit[];
  };
  readonly files: readonly { readonly path: string; readonly blobRef: string }[];
}

export async function* readableProjectsForExport(
  db: KobeDb,
  viewer: { readonly teamId: string; readonly userId: string },
): AsyncGenerator<ExportedProject> {
  const owned = await withTeam(db, viewer.teamId, (tx) =>
    tx.execute<{ id: string; slug: string; name: string; head_commit_id: string | null }>(sql`
      SELECT p.id, p.slug, p.name, p.head_commit_id FROM projects p
       WHERE p.team_id = ${viewer.teamId}
         AND EXISTS (SELECT 1 FROM team_members t
                      WHERE t.team_id = p.team_id AND t.user_id = ${viewer.userId})
         AND ${viewableBy(viewer.userId)}
       ORDER BY p.slug`),
  );
  for (const p of owned.rows) {
    const { commits, tree } = await withTeam(db, viewer.teamId, async (tx) => ({
      commits: (
        await tx.execute<CommitRow>(sql`
          SELECT ${COMMIT_COLUMNS} FROM project_commits
           WHERE team_id = ${viewer.teamId} AND project_id = ${p.id}
           ORDER BY seq DESC LIMIT ${HISTORY_MAX}`)
      ).rows.map(toCommit),
      tree: await loadTree(tx, viewer.teamId, p.head_commit_id),
    }));
    yield {
      slug: p.slug,
      meta: {
        id: p.id,
        slug: p.slug,
        name: p.name,
        head_seq: commits.find((c) => c.id === p.head_commit_id)?.seq ?? null,
        commits,
      },
      files: [...tree.values()].map((f) => ({ path: f.path, blobRef: f.blobRef })),
    };
  }
}

/** The object of a head file, or null when it is missing or outside the project's tree. */
export async function projectObject(
  blobs: BlobStore,
  teamId: string,
  projectId: string,
  key: string,
) {
  if (!isProjectKey(blobs.prefix, teamId, projectId, key)) return null;
  return blobs.objects.get(key).catch((err: unknown) => {
    logger.warn({ err, teamId }, "export: project file unreadable");
    return null;
  });
}
