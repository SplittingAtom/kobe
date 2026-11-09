import {
  and,
  eq,
  inArray,
  projectFiles,
  projects,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { PROJECT_MOUNTS_MAX_PER_MEMBER, PROJECT_WORKSPACE_DIR } from "@kobe/protocol";
import type { Logger } from "pino";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import { listLive, lockWorkspace } from "../workspace-sync/store.js";
import { viewableBy } from "./access.js";

/**
 * Project files in members' workspaces (KOBE-162, ac-1; mechanism and why in
 * docs/ledger/KOBE-162.md). The workspace of each (team, user) is a manifest the sandbox pulls
 * from; the `projects/` area of it is server-owned and read-only to the sandbox. This module keeps
 * that area equal to "the files of the projects this user has open" (Workspaces MT1, KOBE-578):
 * the projects where they own a thread that is not in Trash, or hold a checkout, and may still
 * view. A checked-out project's rows are the member's working copy (KOBE-579): reconcile neither
 * writes nor deletes anything under its folder.
 *
 * - {@link ProjectMounts.reconcileUser} makes one user's `projects/` rows exactly that set: puts
 *   what is missing or changed (pointing at the project file's own object, so nothing is copied),
 *   deletes what no longer belongs (a removed member, a deleted file, a project that was left).
 *   It is idempotent and a no-op when nothing differs, so it runs at every run start (the
 *   authoritative refresh) and after any change that affects a user.
 * - {@link ProjectMounts.reconcileProject} does that for everyone who has the project open (file
 *   added or removed); {@link ProjectMounts.reconcileUsers} for named users (member removed,
 *   thread created, moved, trashed or restored).
 *
 * Failures are logged and never thrown to the caller: the next run start reconciles again.
 */
export interface ProjectMounts {
  /** Binds the workspace store once it exists (it is built after the server deps). */
  use(sync: WorkspaceSync): void;
  readonly enabled: boolean;
  /** The reconcile methods resolve true only when every workspace was brought in line. */
  reconcileUser(teamId: string, userId: string): Promise<boolean>;
  reconcileUsers(teamId: string, userIds: readonly string[]): Promise<boolean>;
  reconcileProject(teamId: string, projectId: string): Promise<boolean>;
  /** Every member of the team: a project's members mode changed, so who lost access is not listed by it. */
  reconcileTeam(teamId: string): Promise<boolean>;
  /** In the caller's transaction: the same as {@link reconcileUser} (for tests and run start). */
  reconcileUserIn(tx: KobeTx, teamId: string, userId: string): Promise<void>;
}

interface Desired {
  readonly sha256: string;
  readonly size: number;
  readonly blobKey: string;
  readonly mtimeMs: number;
}

const AREA = `${PROJECT_WORKSPACE_DIR}/`;
/** More than any one user may hold (500 files per project); a runaway diff stops here. */
const LIST_LIMIT = 50_000;
/** Users reconciled at once after a project-wide change. */
const BATCH = 8;

/** The workspace setting that caps a member's open projects (MT3); absent or invalid = 20. */
export const MOUNTS_MAX_SETTING = "projects.max_mounted_per_member";

/**
 * The projects open for `userId` (MT1): their own threads not in Trash, plus their checkouts,
 * limited to projects they may view; nothing once they left the team or were deactivated (MT4). `excludeThreadId` leaves one
 * thread out (a move asks what stays open without it). `checkedOut` = the subset with a checkout.
 */
export async function openProjects(
  tx: KobeTx,
  teamId: string,
  userId: string,
  options: { excludeThreadId?: string } = {},
): Promise<{ ids: Set<string>; checkedOut: Set<string> }> {
  const exclude = options.excludeThreadId ?? null;
  const res = await tx.execute<{ id: string; checked_out: boolean }>(sql`
    SELECT p.id,
           EXISTS (SELECT 1 FROM project_checkouts c
                    WHERE c.team_id = p.team_id AND c.project_id = p.id
                      AND c.user_id = ${userId}) AS checked_out
      FROM projects p
     WHERE p.team_id = ${teamId}
       AND EXISTS (SELECT 1 FROM team_members t WHERE t.team_id = p.team_id AND t.user_id = ${userId})
       AND EXISTS (SELECT 1 FROM users u WHERE u.id = ${userId} AND u.deactivated_at IS NULL)
       AND ${viewableBy(userId)}
       AND (EXISTS (SELECT 1 FROM threads th
                     WHERE th.team_id = ${teamId} AND th.project_id = p.id
                       AND th.owner_user_id = ${userId} AND th.deleted_at IS NULL
                       AND (${exclude}::uuid IS NULL OR th.id <> ${exclude}::uuid))
            OR EXISTS (SELECT 1 FROM project_checkouts c
                        WHERE c.team_id = p.team_id AND c.project_id = p.id
                          AND c.user_id = ${userId}))`);
  return {
    ids: new Set(res.rows.map((r) => r.id)),
    checkedOut: new Set(res.rows.filter((r) => r.checked_out).map((r) => r.id)),
  };
}

/** The workspace's cap on open projects per member (MT3): the team setting, else the default. */
export async function mountLimit(tx: KobeTx, teamId: string): Promise<number> {
  const res = await tx.execute<{ v: unknown }>(sql`
    SELECT settings -> ${MOUNTS_MAX_SETTING} AS v FROM teams WHERE id = ${teamId}`);
  const v = res.rows[0]?.v;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0
    ? v
    : PROJECT_MOUNTS_MAX_PER_MEMBER;
}

/**
 * The limit when opening `projectId` for `userId` would pass the cap (a new project conversation,
 * MT3: `too_many_mounts`); undefined when allowed (already open, or room left). `movingThreadId`:
 * the thread being moved no longer keeps its old project open.
 */
export async function mountCapRefusal(
  tx: KobeTx,
  viewer: { teamId: string; userId: string },
  projectId: string,
  movingThreadId?: string,
): Promise<number | undefined> {
  const now = await openProjects(tx, viewer.teamId, viewer.userId);
  if (now.ids.has(projectId)) return undefined;
  const { ids } =
    movingThreadId === undefined
      ? now
      : await openProjects(tx, viewer.teamId, viewer.userId, { excludeThreadId: movingThreadId });
  const limit = await mountLimit(tx, viewer.teamId);
  return ids.size >= limit ? limit : undefined;
}

interface Mounts {
  readonly wanted: Map<string, Desired>;
  /** Folders (`projects/<slug>/`) of the member's checkouts: their rows are never touched. */
  readonly working: readonly string[];
}

/** The files a user should see, by mount path, and the checked-out folders to leave alone. */
async function desiredFor(tx: KobeTx, teamId: string, userId: string): Promise<Mounts> {
  const wanted = new Map<string, Desired>();
  const { ids, checkedOut } = await openProjects(tx, teamId, userId);
  const working: string[] = [];
  if (checkedOut.size > 0) {
    const rows = await tx
      .select({ slug: projects.slug })
      .from(projects)
      .where(and(eq(projects.teamId, teamId), inArray(projects.id, [...checkedOut])));
    for (const r of rows) working.push(`${AREA}${r.slug}/`);
  }
  const mounted = [...ids].filter((id) => !checkedOut.has(id));
  if (mounted.length === 0) return { wanted, working };
  const rows = await tx
    .select({
      slug: projects.slug,
      path: projectFiles.path,
      sha256: projectFiles.sha256,
      size: projectFiles.sizeBytes,
      blobRef: projectFiles.blobRef,
      addedAt: projectFiles.addedAt,
    })
    .from(projectFiles)
    .innerJoin(
      projects,
      and(eq(projects.teamId, projectFiles.teamId), eq(projects.id, projectFiles.projectId)),
    )
    .where(and(eq(projectFiles.teamId, teamId), inArray(projectFiles.projectId, mounted)));
  for (const r of rows) {
    wanted.set(`${AREA}${r.slug}/${r.path}`, {
      sha256: r.sha256,
      size: r.size,
      blobKey: r.blobRef,
      mtimeMs: r.addedAt.getTime(),
    });
  }
  return { wanted, working };
}

async function diff(tx: KobeTx, teamId: string, userId: string) {
  const { wanted, working } = await desiredFor(tx, teamId, userId);
  const current = new Map(
    (await listLive(tx, { teamId, userId }, AREA, LIST_LIMIT))
      .filter((e) => !working.some((dir) => e.path.startsWith(dir)))
      .map((e) => [e.path, e]),
  );
  const puts = [...wanted].filter(([path, want]) => {
    const have = current.get(path);
    return have?.sha256 !== want.sha256 || have.blobKey !== want.blobKey;
  });
  const deletes = [...current.keys()].filter((path) => !wanted.has(path));
  return { puts, deletes };
}

async function reconcile(
  tx: KobeTx,
  sync: WorkspaceSync,
  teamId: string,
  userId: string,
): Promise<void> {
  const owner = { teamId, userId };
  // Nothing to do is the common case (every run start): no lock, no write.
  const first = await diff(tx, teamId, userId);
  if (first.puts.length + first.deletes.length === 0) return;
  // Locked first, so a reconcile that read the data later never loses to one that read it earlier.
  await lockWorkspace(tx, owner);
  const { puts, deletes } = await diff(tx, teamId, userId);
  for (const [path, want] of puts) {
    await sync.putServerFile(
      tx,
      owner,
      { path, sha256: want.sha256, size: want.size, blobKey: want.blobKey, mtimeMs: want.mtimeMs },
      "projects",
    );
  }
  for (const path of deletes) await sync.deleteServerFile(tx, owner, path);
}

/**
 * Everyone whose workspace the project's files concern: who has it open (MT1: a thread of their
 * own not in Trash, or a checkout) and whoever still holds a live row under its folder (mounted
 * under an older rule, or a removal whose reconcile was missed). The second set matters for file
 * removal: the object is deleted only once no workspace names it.
 */
async function membersOf(tx: KobeTx, teamId: string, projectId: string): Promise<string[]> {
  const res = await tx.execute<{ user_id: string }>(sql`
    SELECT owner_user_id AS user_id FROM threads
     WHERE team_id = ${teamId} AND project_id = ${projectId} AND deleted_at IS NULL
    UNION
    SELECT user_id FROM project_checkouts WHERE team_id = ${teamId} AND project_id = ${projectId}
    UNION
    SELECT DISTINCT f.user_id FROM workspace_files f
      JOIN projects p ON p.team_id = f.team_id AND p.id = ${projectId}
     WHERE f.team_id = ${teamId} AND NOT f.deleted
       AND starts_with(f.path, ${AREA} || p.slug || '/')`);
  return res.rows.map((r) => r.user_id);
}

export function createProjectMounts(db: KobeDb, log: Pick<Logger, "warn">): ProjectMounts {
  let sync: WorkspaceSync | undefined;
  const reconcileUsers = async (teamId: string, userIds: readonly string[]): Promise<boolean> => {
    const store = sync;
    if (!store) return true;
    let allOk = true;
    for (let i = 0; i < userIds.length; i += BATCH) {
      await Promise.all(
        userIds.slice(i, i + BATCH).map(async (userId) => {
          try {
            await withTeam(db, teamId, (tx) => reconcile(tx, store, teamId, userId));
          } catch (err) {
            allOk = false;
            log.warn({ err, teamId }, "project files: could not update a workspace");
          }
        }),
      );
    }
    return allOk;
  };
  return {
    use: (store) => {
      sync = store;
    },
    get enabled() {
      return sync !== undefined;
    },
    reconcileUsers,
    reconcileUser: (teamId, userId) => reconcileUsers(teamId, [userId]),
    async reconcileTeam(teamId) {
      if (!sync) return true;
      try {
        const users = await withTeam(db, teamId, async (tx) => {
          const res = await tx.execute<{ user_id: string }>(
            sql`SELECT user_id FROM team_members WHERE team_id = ${teamId}`,
          );
          return res.rows.map((r) => r.user_id);
        });
        return await reconcileUsers(teamId, users);
      } catch (err) {
        log.warn({ err, teamId }, "project files: could not list the team to update");
        return false;
      }
    },
    async reconcileProject(teamId, projectId) {
      if (!sync) return true;
      try {
        const users = await withTeam(db, teamId, (tx) => membersOf(tx, teamId, projectId));
        return await reconcileUsers(teamId, users);
      } catch (err) {
        log.warn({ err, teamId }, "project files: could not list the members to update");
        return false;
      }
    },
    async reconcileUserIn(tx, teamId, userId) {
      if (sync) await reconcile(tx, sync, teamId, userId);
    },
  };
}
