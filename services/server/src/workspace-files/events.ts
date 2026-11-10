import { sql, type KobeTx } from "@kobe/db";
import type { WorkspaceEvent } from "@kobe/protocol";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";

/**
 * What `GET /v1/workspace/events` (KOBE-599) compares: the head revision of the caller's own
 * (team, user) manifest, and one opaque digest of the team's projects (head commit, slug, name,
 * archived) with the caller's own checkouts. `owner` is always the session's team and user and
 * every statement names both (inside `withTeam`, so RLS holds it to the team too): no input can
 * reach another member's or another team's rows, and the digest says only "something changed".
 */
export async function readWorkspaceVersions(
  tx: KobeTx,
  owner: WorkspaceOwner,
): Promise<WorkspaceEvent> {
  const res = await tx.execute<{ files_rev: string | null; projects_rev: string }>(sql`
    SELECT
      (SELECT w.head_rev FROM workspace_sync w
        WHERE w.team_id = ${owner.teamId} AND w.user_id = ${owner.userId}) AS files_rev,
      md5(
        coalesce((SELECT string_agg(
                     concat_ws(':', p.id, p.head_commit_id, p.slug, p.name, p.archived_at,
                               p.updated_at), ',' ORDER BY p.id)
                    FROM projects p WHERE p.team_id = ${owner.teamId}), '')
        || '|' ||
        coalesce((SELECT string_agg(
                     concat_ws(':', c.project_id, c.base_commit_id, c.updated_at), ','
                     ORDER BY c.project_id)
                    FROM project_checkouts c
                   WHERE c.team_id = ${owner.teamId} AND c.user_id = ${owner.userId}), '')
      ) AS projects_rev`);
  const row = res.rows[0];
  return {
    files_rev: Number(row?.files_rev ?? 0),
    projects_rev: row?.projects_rev ?? "0",
  };
}

/** Whether two versions differ (the panel lists again when they do). */
export function versionsDiffer(a: WorkspaceEvent, b: WorkspaceEvent): boolean {
  return a.files_rev !== b.files_rev || a.projects_rev !== b.projects_rev;
}
