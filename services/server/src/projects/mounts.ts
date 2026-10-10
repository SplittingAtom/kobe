import {
  and,
  eq,
  inArray,
  projectFiles,
  projects,
  sql,
  teamMembers,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { PROJECT_WORKSPACE_DIR } from "@kobe/protocol";
import type { Logger } from "pino";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import { listLive, lockWorkspace } from "../workspace-sync/store.js";
import { memberProjectIds } from "./access.js";

/**
 * Project files in members' workspaces (KOBE-162, ac-1; mechanism and why in
 * docs/ledger/KOBE-162.md). The workspace of each (team, user) is a manifest the sandbox pulls
 * from; the `projects/` area of it is server-owned and read-only to the sandbox. This module keeps
 * that area equal to "the files of the projects this user is a member of":
 *
 * - {@link ProjectMounts.reconcileUser} makes one user's `projects/` rows exactly that set: puts
 *   what is missing or changed (pointing at the project file's own object, so nothing is copied),
 *   deletes what no longer belongs (a removed member, a deleted file, a project that was left).
 *   It is idempotent and a no-op when nothing differs, so it runs at every run start (the
 *   authoritative refresh) and after any change that affects a user.
 * - {@link ProjectMounts.reconcileProject} does that for every member of a project (file added or
 *   removed, members mode changed); {@link ProjectMounts.reconcileUsers} for named users (member
 *   removed: the user is no longer a member, so their rows go).
 *
 * Failures are logged and never thrown to the caller: the next run start reconciles again.
 */
export interface ProjectMounts {
  /** Binds the workspace store once it exists (it is built after the server deps). */
  use(sync: WorkspaceSync): void;
  readonly enabled: boolean;
  reconcileUser(teamId: string, userId: string): Promise<void>;
  reconcileUsers(teamId: string, userIds: readonly string[]): Promise<void>;
  reconcileProject(teamId: string, projectId: string): Promise<void>;
  /** Every member of the team: a project's members mode changed, so who lost access is not listed by it. */
  reconcileTeam(teamId: string): Promise<void>;
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

/** The files a user should see: those of every project they are a member of, by mount path. */
async function desiredFor(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<Map<string, Desired>> {
  const [teamMember] = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  const wanted = new Map<string, Desired>();
  if (!teamMember) return wanted; // left the team: nothing is mounted
  const ids = await memberProjectIds(tx, teamId, userId);
  if (ids.length === 0) return wanted;
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
    .where(and(eq(projectFiles.teamId, teamId), inArray(projectFiles.projectId, [...ids])));
  for (const r of rows) {
    wanted.set(`${AREA}${r.slug}/${r.path}`, {
      sha256: r.sha256,
      size: r.size,
      blobKey: r.blobRef,
      mtimeMs: r.addedAt.getTime(),
    });
  }
  return wanted;
}

async function diff(tx: KobeTx, teamId: string, userId: string) {
  const wanted = await desiredFor(tx, teamId, userId);
  const current = new Map(
    (await listLive(tx, { teamId, userId }, AREA, LIST_LIMIT)).map((e) => [e.path, e]),
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

/** Members of a project right now (explicit rows, or the whole team in mode `team`). */
async function membersOf(tx: KobeTx, teamId: string, projectId: string): Promise<string[]> {
  const res = await tx.execute<{ user_id: string }>(sql`
    SELECT tm.user_id FROM projects p
      JOIN team_members tm ON tm.team_id = p.team_id
     WHERE p.team_id = ${teamId} AND p.id = ${projectId}
       AND (p.members_mode = 'team'
            OR EXISTS (SELECT 1 FROM project_members m
                        WHERE m.team_id = p.team_id AND m.project_id = p.id
                          AND m.user_id = tm.user_id))`);
  return res.rows.map((r) => r.user_id);
}

export function createProjectMounts(db: KobeDb, log: Pick<Logger, "warn">): ProjectMounts {
  let sync: WorkspaceSync | undefined;
  const reconcileUsers = async (teamId: string, userIds: readonly string[]): Promise<void> => {
    const store = sync;
    if (!store) return;
    for (let i = 0; i < userIds.length; i += BATCH) {
      await Promise.all(
        userIds.slice(i, i + BATCH).map(async (userId) => {
          try {
            await withTeam(db, teamId, (tx) => reconcile(tx, store, teamId, userId));
          } catch (err) {
            log.warn({ err, teamId }, "project files: could not update a workspace");
          }
        }),
      );
    }
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
      if (!sync) return;
      try {
        const users = await withTeam(db, teamId, async (tx) => {
          const res = await tx.execute<{ user_id: string }>(
            sql`SELECT user_id FROM team_members WHERE team_id = ${teamId}`,
          );
          return res.rows.map((r) => r.user_id);
        });
        await reconcileUsers(teamId, users);
      } catch (err) {
        log.warn({ err, teamId }, "project files: could not list the team to update");
      }
    },
    async reconcileProject(teamId, projectId) {
      if (!sync) return;
      try {
        const users = await withTeam(db, teamId, (tx) => membersOf(tx, teamId, projectId));
        await reconcileUsers(teamId, users);
      } catch (err) {
        log.warn({ err, teamId }, "project files: could not list the members to update");
      }
    },
    async reconcileUserIn(tx, teamId, userId) {
      if (sync) await reconcile(tx, sync, teamId, userId);
    },
  };
}
