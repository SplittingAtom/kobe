import { sql, type KobeTx, type ThreadFileAccess } from "@kobe/db";
import { underPattern } from "../workspace-files/paths.js";
import { projectMountPath } from "./paths.js";

/**
 * Writing thread–file links (KOBE-610, spec thread-file-map §3). Every writer runs inside the
 * team's `withTeam` transaction. One row per (thread, owner or project, path, access): a repeated
 * use bumps `last_at` and `count`. Moves and deletes are followed by triggers (migration
 * `*_thread_file_links_rls.sql`), so nothing here deals with them.
 */

/** A link in a member's own workspace (`owner_user_id`) or in a project (`project_id`). */
export type LinkTarget =
  | { readonly ownerUserId: string; readonly projectId?: undefined; readonly path: string }
  | { readonly projectId: string; readonly ownerUserId?: undefined; readonly path: string };

export type LinkInput = LinkTarget & {
  readonly threadId: string;
  readonly access: ThreadFileAccess;
  /** When it happened, the latest use (default now). */
  readonly at?: Date;
  /** The first use, when the row stands for several (default `at`). */
  readonly firstAt?: Date;
  /** How many uses this row stands for (default 1). */
  readonly count?: number;
};

/**
 * How counts combine on conflict: `add` for live uses; `max` for the backfill, so running it again
 * (or after live links of the same calls) never inflates a count (idempotent).
 */
export type CountMerge = "add" | "max";

/**
 * A workspace path of `ownerUserId`'s `/workspace` as a link target: a mounted project's
 * `projects/<slug>/<file>` is the project's file (the link survives a slug rename and is seen by
 * the project's readers, TFM7); a project path of no current project is no link.
 */
export async function resolveTarget(
  tx: KobeTx,
  teamId: string,
  ownerUserId: string,
  path: string,
): Promise<LinkTarget | undefined> {
  if (path === "projects") return undefined;
  const mount = projectMountPath(path);
  if (path.startsWith("projects/") && mount === undefined) return undefined;
  if (mount === undefined) return { ownerUserId, path };
  const res = await tx.execute<{ id: string }>(sql`
    SELECT id FROM projects WHERE team_id = ${teamId} AND slug = ${mount.slug}`);
  const projectId = res.rows[0]?.id;
  return projectId === undefined ? undefined : { projectId, path: mount.inner };
}

/** Whether the target exists now: a live file, or (owner paths) a folder with live files. */
async function exists(tx: KobeTx, teamId: string, target: LinkTarget): Promise<boolean> {
  if (target.projectId !== undefined) {
    const res = await tx.execute(sql`
      SELECT 1 FROM project_files
       WHERE team_id = ${teamId} AND project_id = ${target.projectId} AND path = ${target.path}`);
    return res.rows.length > 0;
  }
  const res = await tx.execute(sql`
    SELECT 1 FROM workspace_files
     WHERE team_id = ${teamId} AND user_id = ${target.ownerUserId} AND NOT deleted
       AND (path = ${target.path} OR path LIKE ${underPattern(target.path)})
     LIMIT 1`);
  return res.rows.length > 0;
}

/**
 * Upserts links. A link to a path that does not exist (yet) is marked deleted; the file's arrival
 * (the sandbox's push, a server write) clears the mark through the trigger.
 */
export async function recordLinks(
  tx: KobeTx,
  teamId: string,
  links: readonly LinkInput[],
  merge: CountMerge = "add",
): Promise<void> {
  const count =
    merge === "add"
      ? sql`LEAST(thread_file_links.count::int8 + EXCLUDED.count, 2147483647)::int4`
      : sql`GREATEST(thread_file_links.count, EXCLUDED.count)`;
  for (const link of links) {
    const at = link.at ?? new Date();
    const firstAt = link.firstAt !== undefined && link.firstAt < at ? link.firstAt : at;
    const deletedAt = (await exists(tx, teamId, link)) ? null : at;
    await tx.execute(sql`
      INSERT INTO thread_file_links
        (team_id, thread_id, owner_user_id, project_id, path, access, first_at, last_at, count,
         deleted_at)
      VALUES (${teamId}, ${link.threadId}, ${link.ownerUserId ?? null}, ${link.projectId ?? null},
              ${link.path}, ${link.access}, ${firstAt}, ${at}, ${Math.max(1, link.count ?? 1)},
              ${deletedAt})
      ON CONFLICT ON CONSTRAINT thread_file_links_key DO UPDATE SET
        first_at = LEAST(thread_file_links.first_at, EXCLUDED.first_at),
        last_at = GREATEST(thread_file_links.last_at, EXCLUDED.last_at),
        count = ${count},
        deleted_at = CASE WHEN EXCLUDED.last_at >= thread_file_links.last_at
                          THEN EXCLUDED.deleted_at ELSE thread_file_links.deleted_at END`);
  }
}

/**
 * Links `threadId` to a path of `ownerUserId`'s workspace (an attachment, an allowed tool call),
 * resolving project mounts; paths that name no target are skipped.
 */
export async function recordWorkspaceLink(
  tx: KobeTx,
  input: {
    readonly teamId: string;
    readonly threadId: string;
    readonly ownerUserId: string;
    readonly path: string;
    readonly access: ThreadFileAccess;
    readonly at?: Date;
  },
): Promise<boolean> {
  const target = await resolveTarget(tx, input.teamId, input.ownerUserId, input.path);
  if (target === undefined) return false;
  await recordLinks(tx, input.teamId, [
    {
      ...target,
      threadId: input.threadId,
      access: input.access,
      ...(input.at ? { at: input.at } : {}),
    },
  ]);
  return true;
}
