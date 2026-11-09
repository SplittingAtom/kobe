import { sql, type KobeTx } from "@kobe/db";
import { PROJECT_WORKSPACE_DIR, type WorkspaceCheckoutRef } from "@kobe/protocol";
import type { WorkspaceOwner } from "./keys.js";

/**
 * A member's project checkouts as the workspace sees them (KOBE-579, Workspaces CM2-CM4). The
 * `projects/` area is server-owned and read-only, except `projects/<slug>/` of a project the caller
 * (team, user) has checked out: there the sandbox may push and the Files routes may write. The
 * exception is per checkout and per member; `WORKSPACE_SERVER_OWNED_PREFIXES` is unchanged.
 */

const AREA = `${PROJECT_WORKSPACE_DIR}/`;

/** The caller's checkouts with the slug and the base's seq (the sync pull's `checkouts`). */
export async function checkoutRefs(
  tx: KobeTx,
  owner: WorkspaceOwner,
): Promise<WorkspaceCheckoutRef[]> {
  const res = await tx.execute<{ project_id: string; slug: string; seq: number | null }>(sql`
    SELECT c.project_id, p.slug, b.seq
      FROM project_checkouts c
      JOIN projects p ON p.team_id = c.team_id AND p.id = c.project_id
      LEFT JOIN project_commits b ON b.team_id = c.team_id AND b.id = c.base_commit_id
     WHERE c.team_id = ${owner.teamId} AND c.user_id = ${owner.userId}
     ORDER BY p.slug`);
  return res.rows.map((r) => ({
    project_id: r.project_id,
    slug: r.slug,
    base_commit_seq: r.seq === null ? null : Number(r.seq),
  }));
}

/** The slugs of the caller's checkouts. */
export async function checkoutSlugs(
  tx: KobeTx,
  owner: WorkspaceOwner,
): Promise<ReadonlySet<string>> {
  return new Set((await checkoutRefs(tx, owner)).map((r) => r.slug));
}

/** The checkout slug `path` lies strictly inside (`projects/<slug>/…`), if it is one of `slugs`. */
export function checkoutOf(path: string, slugs: ReadonlySet<string>): string | undefined {
  if (!path.startsWith(AREA)) return undefined;
  const rest = path.slice(AREA.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  const slug = rest.slice(0, slash);
  return slugs.has(slug) ? slug : undefined;
}

/**
 * Whether every `projects/…` path among `paths` lies in one of the caller's checkouts, read now:
 * call it under the workspace lock, in the transaction that writes (as the sync push does), so a
 * write racing a Discard or a lost `edit` is refused instead of landing in a relocked folder.
 */
export async function checkoutsHold(
  tx: KobeTx,
  owner: WorkspaceOwner,
  paths: readonly string[],
): Promise<boolean> {
  const inProjects = paths.filter((p) => p === PROJECT_WORKSPACE_DIR || p.startsWith(AREA));
  if (inProjects.length === 0) return true;
  const slugs = await checkoutSlugs(tx, owner);
  return inProjects.every((p) => checkoutOf(p, slugs) !== undefined);
}

export const NO_CHECKOUTS: ReadonlySet<string> = new Set();
