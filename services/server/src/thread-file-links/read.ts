import { sql, type KobeTx } from "@kobe/db";
import {
  FILE_THREADS_MAX_THREADS,
  THREAD_FILE_LINKS_MAX_FILES,
  type FileThreadsEntry,
  type ThreadFileLink,
  type ThreadFileLinks,
} from "@kobe/protocol";
import { readableBy, type Viewer } from "../threads/repository.js";
import { projectMountPath, projectTreePath } from "./paths.js";

/**
 * The reads of thread–file links (KOBE-611, contract `thread-file-links.ts`; privacy TFM7). The
 * viewer's own workspace and the projects they can read (`viewer.projectIds`, every project of the
 * team since RV1) are named; everything else only counted. Inside the team's `withTeam`.
 */

const uuidList = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;
const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

type LinkRow = {
  thread_id: string;
  project_id: string | null;
  slug: string | null;
  path: string;
  wrote: boolean;
  last_at: Date | string;
  deleted: boolean;
};

/**
 * The links of `threadIds`, which the caller has checked the viewer may read: per thread, the
 * newest {@link THREAD_FILE_LINKS_MAX_FILES} files the viewer may see by name, and how many other
 * files it used (`hidden_count`: teammates' workspaces, files beyond the cap). One row per file:
 * `write` if any use wrote it, the latest use, deleted when every row of it is.
 */
export async function linksOfThreads(
  tx: KobeTx,
  viewer: Viewer,
  threadIds: readonly string[],
): Promise<ThreadFileLinks[]> {
  if (threadIds.length === 0) return [];
  // COALESCE: a null side (owner or project) must read as "not visible", never as unknown.
  const visible = sql`COALESCE(l.owner_user_id = ${viewer.userId}
                               OR l.project_id = ANY(${uuidList(viewer.projectIds)}), false)`;
  const grouped = sql`
    SELECT l.thread_id, l.owner_user_id, l.project_id, l.path,
           bool_or(l.access = 'write') AS wrote, max(l.last_at) AS last_at,
           bool_and(l.deleted_at IS NOT NULL) AS deleted, bool_or(${visible}) AS visible
      FROM thread_file_links l
     WHERE l.team_id = ${viewer.teamId} AND l.thread_id = ANY(${uuidList(threadIds)})
     GROUP BY l.thread_id, l.owner_user_id, l.project_id, l.path`;
  const rows = await tx.execute<LinkRow>(sql`
    WITH g AS (${grouped}),
    r AS (SELECT g.*, row_number() OVER (PARTITION BY g.thread_id
                                          ORDER BY g.last_at DESC, g.path) AS rn
            FROM g WHERE g.visible)
    SELECT r.thread_id, r.project_id, p.slug, r.path, r.wrote, r.last_at, r.deleted
      FROM r LEFT JOIN projects p ON p.team_id = ${viewer.teamId} AND p.id = r.project_id
     WHERE r.rn <= ${THREAD_FILE_LINKS_MAX_FILES}
     ORDER BY r.thread_id, r.rn`);
  const counts = await tx.execute<{ thread_id: string; hidden: string | number }>(sql`
    WITH g AS (${grouped})
    SELECT thread_id,
           count(*) FILTER (WHERE NOT visible)
             + GREATEST(count(*) FILTER (WHERE visible) - ${THREAD_FILE_LINKS_MAX_FILES}, 0)
             AS hidden
      FROM g GROUP BY thread_id`);
  const files = new Map<string, ThreadFileLink[]>();
  for (const row of rows.rows) {
    const path =
      row.project_id === null
        ? row.path
        : row.slug === null
          ? undefined
          : projectTreePath(row.slug, row.path);
    if (path === undefined) continue;
    const list = files.get(row.thread_id) ?? [];
    list.push({
      path,
      project_id: row.project_id,
      access: row.wrote ? "write" : "read",
      last_at: iso(row.last_at),
      deleted: row.deleted,
    });
    files.set(row.thread_id, list);
  }
  const hidden = new Map(counts.rows.map((r) => [r.thread_id, Number(r.hidden)]));
  return threadIds.map((id) => ({
    thread_id: id,
    files: files.get(id) ?? [],
    hidden_count: hidden.get(id) ?? 0,
  }));
}

type Target =
  | { readonly kind: "own"; readonly path: string }
  | { readonly kind: "project"; readonly projectId: string; readonly path: string };

/** The workspace-tree paths as link targets: own files, or readable projects' files by slug. */
async function targetsOf(
  tx: KobeTx,
  viewer: Viewer,
  paths: readonly string[],
): Promise<Map<string, Target>> {
  const out = new Map<string, Target>();
  const slugs = new Set<string>();
  for (const path of paths) {
    const mount = projectMountPath(path);
    if (mount !== undefined) slugs.add(mount.slug);
    else if (path !== "projects" && !path.startsWith("projects/")) {
      out.set(path, { kind: "own", path });
    }
  }
  if (slugs.size === 0) return out;
  const res = await tx.execute<{ id: string; slug: string }>(sql`
    SELECT id, slug FROM projects
     WHERE team_id = ${viewer.teamId} AND slug IN ${[...slugs]}`);
  const bySlug = new Map(
    res.rows.filter((r) => viewer.projectIds.includes(r.id)).map((r) => [r.slug, r.id]),
  );
  for (const path of paths) {
    const mount = projectMountPath(path);
    const projectId = mount === undefined ? undefined : bySlug.get(mount.slug);
    if (mount !== undefined && projectId !== undefined) {
      out.set(path, { kind: "project", projectId, path: mount.inner });
    }
  }
  return out;
}

type ThreadRow = {
  project_id: string | null;
  path: string;
  thread_id: string;
  title: string | null;
  wrote: boolean;
  last_at: Date | string;
  visible: boolean;
};

/**
 * For each workspace-tree path, the threads that used it, newest first: at most
 * {@link FILE_THREADS_MAX_THREADS} live, listable threads the viewer may read, by title; `more`
 * counts the rest (unreadable, in Trash, test or eval threads, beyond the cap). A path the viewer
 * cannot see (another member's project they cannot read, an unknown project) has none.
 */
export async function threadsOfPaths(
  tx: KobeTx,
  viewer: Viewer,
  paths: readonly string[],
): Promise<FileThreadsEntry[]> {
  const targets = await targetsOf(tx, viewer, paths);
  const own = [...targets.values()].flatMap((t) => (t.kind === "own" ? [t.path] : []));
  const byProject = new Map<string, string[]>();
  for (const t of targets.values()) {
    if (t.kind === "project")
      byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t.path]);
  }
  const conditions = [
    ...(own.length > 0 ? [sql`(l.owner_user_id = ${viewer.userId} AND l.path IN ${own})`] : []),
    ...[...byProject].map(
      ([projectId, inner]) => sql`(l.project_id = ${projectId} AND l.path IN ${inner})`,
    ),
  ];
  const rows =
    conditions.length === 0
      ? []
      : (
          await tx.execute<ThreadRow>(sql`
    SELECT l.project_id, l.path, threads.id AS thread_id, threads.title,
           bool_or(l.access = 'write') AS wrote, max(l.last_at) AS last_at,
           (${readableBy(viewer)} AND threads.deleted_at IS NULL AND NOT threads.is_test
             AND NOT threads.skill_eval) AS visible
      FROM thread_file_links l
      JOIN threads ON threads.team_id = l.team_id AND threads.id = l.thread_id
     WHERE l.team_id = ${viewer.teamId} AND threads.team_id = ${viewer.teamId}
       AND (${sql.join(conditions, sql` OR `)})
     GROUP BY l.owner_user_id, l.project_id, l.path, threads.team_id, threads.id
     ORDER BY max(l.last_at) DESC, threads.id`)
        ).rows;
  const keyOf = (projectId: string | null, path: string) => `${projectId ?? ""}\u0000${path}`;
  const grouped = new Map<string, ThreadRow[]>();
  for (const row of rows) {
    const key = keyOf(row.project_id, row.path);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return paths.map((path) => {
    const target = targets.get(path);
    if (target === undefined) return { path, threads: [], more: 0 };
    const all =
      grouped.get(keyOf(target.kind === "project" ? target.projectId : null, target.path)) ?? [];
    const shown = all.filter((r) => r.visible).slice(0, FILE_THREADS_MAX_THREADS);
    return {
      path,
      threads: shown.map((r) => ({
        thread_id: r.thread_id,
        title: r.title,
        access: r.wrote ? ("write" as const) : ("read" as const),
        last_at: iso(r.last_at),
      })),
      more: all.length - shown.length,
    };
  });
}
