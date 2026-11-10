import { endUnreachableThreadRules } from "../policy/user-rules.js";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isLegalHoldViolation,
  isNotNull,
  isNull,
  memoryDocs,
  sql,
  projectFiles,
  projectMembers,
  projects,
  teamMembers,
  threads,
  users,
  type KobeTx,
  type TeamRole,
} from "@kobe/db";
import type {
  CreateProjectRequest,
  Project,
  ProjectMember,
  ProjectMemberRole,
  ProjectRole,
  TransferOwnerResponse,
  UpdateProjectRequest,
} from "@kobe/protocol";
import { canPinAgent, findPinnableAgent } from "../agents/versions.js";
import { queueProjectBlobs } from "./tree.js";
import { recordAudit } from "../audit/record.js";
import { decide, type ProjectAccess, type ProjectRow } from "./access.js";
import { deriveSlug, slugCandidates } from "./slug.js";

export type ProjectFailure =
  | "slug_taken"
  | "not_in_team"
  | "invalid_agent"
  | "last_owner"
  | "already_exists"
  | "not_found"
  | "forbidden"
  | "archived"
  | "in_use"
  | "legal_hold"
  | "user_deactivated";

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProjectFailure; readonly detail?: string };

const fail = (error: ProjectFailure, detail?: string): Outcome<never> => ({
  ok: false,
  error,
  ...(detail === undefined ? {} : { detail }),
});

interface Viewer {
  readonly teamId: string;
  readonly userId: string;
}

export async function toProject(
  tx: KobeTx,
  teamId: string,
  row: ProjectRow,
  myRole: ProjectRole | undefined,
): Promise<Project> {
  const [files] = await tx
    .select({ n: count() })
    .from(projectFiles)
    .where(and(eq(projectFiles.teamId, teamId), eq(projectFiles.projectId, row.id)));
  return {
    id: row.id,
    team_id: row.teamId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    default_agent_id: row.defaultAgentId,
    my_role: myRole ?? null,
    file_count: files?.n ?? 0,
    head_commit_id: row.headCommitId,
    live_bytes: row.liveBytes,
    history_bytes: row.historyBytes,
    live_objects: row.liveObjects,
    history_objects: row.historyObjects,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    archived_at: row.archivedAt?.toISOString() ?? null,
  };
}

/** A default agent must be a team or gallery agent that can start threads: personal agents only work for their owner. */
async function validAgent(tx: KobeTx, viewer: Viewer, agentId: string): Promise<boolean> {
  const agent = await findPinnableAgent(tx, viewer, agentId);
  return agent !== null && agent.scope !== "personal" && canPinAgent(agent);
}

async function usersInTeam(tx: KobeTx, teamId: string, userIds: readonly string[]) {
  if (userIds.length === 0) return true;
  const rows = await tx
    .select({ id: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), inArray(teamMembers.userId, [...userIds])));
  return rows.length === new Set(userIds).size;
}

async function freeSlug(tx: KobeTx, teamId: string, base: string): Promise<string | undefined> {
  for (const candidate of slugCandidates(base)) {
    const [taken] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.teamId, teamId), eq(projects.slug, candidate)));
    if (!taken) return candidate;
  }
  return undefined;
}

/** Creates a project; the creator becomes `owner`. Audit has ids and field names only. */
export async function createProject(
  tx: KobeTx,
  viewer: Viewer,
  body: CreateProjectRequest,
): Promise<Outcome<{ row: ProjectRow }>> {
  const members = [...new Set(body.member_user_ids ?? [])].filter((id) => id !== viewer.userId);
  if (!(await usersInTeam(tx, viewer.teamId, members))) return fail("not_in_team");
  if (body.default_agent_id && !(await validAgent(tx, viewer, body.default_agent_id))) {
    return fail("invalid_agent");
  }
  const slug =
    body.slug !== undefined
      ? await freeSlug(tx, viewer.teamId, body.slug).then((s) => (s === body.slug ? s : undefined))
      : await freeSlug(tx, viewer.teamId, deriveSlug(body.name));
  if (slug === undefined) return fail("slug_taken");
  const [row] = await tx
    .insert(projects)
    .values({
      teamId: viewer.teamId,
      slug,
      name: body.name,
      description: body.description ?? "",
      instructions: body.instructions ?? "",
      defaultAgentId: body.default_agent_id ?? null,
      createdBy: viewer.userId,
    })
    .returning();
  if (!row) throw new Error("project insert returned no row");
  await tx.insert(projectMembers).values([
    {
      teamId: viewer.teamId,
      projectId: row.id,
      userId: viewer.userId,
      role: "owner",
      addedBy: viewer.userId,
    },
    ...members.map((userId) => ({
      teamId: viewer.teamId,
      projectId: row.id,
      userId,
      role: "editor" as const,
      addedBy: viewer.userId,
    })),
  ]);
  await recordAudit(tx, {
    action: "project.created",
    teamId: viewer.teamId,
    target: { projectId: row.id },
  });
  return { ok: true, value: { row } };
}

/**
 * Projects the caller may view (PR3, PJ2): readers included, every project for a team admin.
 * `editorOnly` (`?role=editor`) narrows to the projects the caller may edit.
 */
export async function listProjects(
  tx: KobeTx,
  viewer: Viewer,
  options: { includeArchived: boolean; teamRole: TeamRole; editorOnly?: boolean },
): Promise<Project[]> {
  const rows = await tx
    .select({ project: projects, role: projectMembers.role })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.teamId, projects.teamId),
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.userId, viewer.userId),
      ),
    )
    .where(
      and(
        eq(projects.teamId, viewer.teamId),
        options.includeArchived ? undefined : isNull(projects.archivedAt),
      ),
    )
    .orderBy(asc(projects.name), asc(projects.id));
  const out: Project[] = [];
  for (const { project, role: explicit } of rows) {
    const { role, can } = decide(options.teamRole, explicit ?? undefined);
    if (!can.view || (options.editorOnly === true && !can.edit)) continue;
    out.push(await toProject(tx, viewer.teamId, project, role));
  }
  return out;
}

/**
 * Projects without an owner row (PR5: the only owner left the workspace), for team admins to
 * assign one ("No owner: assign one"). Archived ones only with `includeArchived`.
 */
export async function listOwnerless(
  tx: KobeTx,
  teamId: string,
  options: { includeArchived: boolean },
): Promise<Project[]> {
  const rows = await tx
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.teamId, teamId),
        options.includeArchived ? undefined : isNull(projects.archivedAt),
        sql`NOT EXISTS (SELECT 1 FROM project_members m
                         WHERE m.team_id = ${projects.teamId} AND m.project_id = ${projects.id}
                           AND m.role = 'owner')`,
      ),
    )
    .orderBy(asc(projects.name), asc(projects.id));
  const out: Project[] = [];
  for (const row of rows) out.push(await toProject(tx, teamId, row, undefined));
  return out;
}

export async function updateProject(
  tx: KobeTx,
  viewer: Viewer,
  access: ProjectAccess,
  body: UpdateProjectRequest,
): Promise<Outcome<{ row: ProjectRow }>> {
  if (body.default_agent_id && !(await validAgent(tx, viewer, body.default_agent_id))) {
    return fail("invalid_agent");
  }
  const [row] = await tx
    .update(projects)
    .set({
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
      ...(body.default_agent_id === undefined ? {} : { defaultAgentId: body.default_agent_id }),
      ...(body.archived === undefined
        ? {}
        : { archivedAt: body.archived ? (access.project.archivedAt ?? new Date()) : null }),
      updatedAt: new Date(),
    })
    .where(and(eq(projects.teamId, viewer.teamId), eq(projects.id, access.project.id)))
    .returning();
  if (!row) throw new Error("project update returned no row");
  // Field names only: instructions and descriptions are content, never audited.
  await recordAudit(tx, {
    action: "project.updated",
    teamId: viewer.teamId,
    target: { projectId: row.id, fields: Object.keys(body).sort() },
  });
  return { ok: true, value: { row } };
}

/** Hard delete, refused while threads, project memory or files still point at the project. */
export async function deleteProject(
  tx: KobeTx,
  viewer: Viewer,
  projectId: string,
): Promise<Outcome<null>> {
  const [t] = await tx
    .select({ n: count() })
    .from(threads)
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.projectId, projectId)));
  const [m] = await tx
    .select({ n: count() })
    .from(memoryDocs)
    .where(and(eq(memoryDocs.teamId, viewer.teamId), eq(memoryDocs.projectId, projectId)));
  const [f] = await tx
    .select({ n: count() })
    .from(projectFiles)
    .where(and(eq(projectFiles.teamId, viewer.teamId), eq(projectFiles.projectId, projectId)));
  const blockers = [
    [t?.n ?? 0, "threads"],
    [m?.n ?? 0, "memory documents"],
    [f?.n ?? 0, "files"],
  ] as const;
  const held = blockers.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  if (held.length > 0) return fail("in_use", held.join(", "));
  try {
    // A savepoint: the hold guard over commit history (0200) refuses the cascade with KH001.
    await tx.transaction(async (sp) => {
      // The history's objects go to the blob deleter (KOBE-579), which deletes each once no row
      // of the team names it any more; queued with the delete, so a refusal queues nothing.
      const refs = await sp.execute<{ key: string }>(sql`
        SELECT DISTINCT e.blob_ref AS key FROM project_tree_entries e
          JOIN project_commits c ON c.team_id = e.team_id AND c.id = e.commit_id
         WHERE c.team_id = ${viewer.teamId} AND c.project_id = ${projectId}`);
      await queueProjectBlobs(
        sp,
        viewer.teamId,
        projectId,
        viewer.userId,
        refs.rows.map((r) => r.key),
      );
      await sp
        .delete(projects)
        .where(and(eq(projects.teamId, viewer.teamId), eq(projects.id, projectId)));
    });
  } catch (err) {
    if (isLegalHoldViolation(err)) return fail("legal_hold");
    throw err;
  }
  await recordAudit(tx, {
    action: "project.deleted",
    teamId: viewer.teamId,
    target: { projectId },
  });
  return { ok: true, value: null };
}

// ----------------------------------------------------------------------------- members

export async function listMembers(tx: KobeTx, teamId: string, projectId: string) {
  const rows = await tx
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.teamId, teamId), eq(projectMembers.projectId, projectId)))
    .orderBy(asc(projectMembers.addedAt), asc(projectMembers.userId));
  return rows.map((r): ProjectMember => ({
    user_id: r.userId,
    role: r.role,
    added_at: r.addedAt.toISOString(),
  }));
}

async function ownerCount(tx: KobeTx, teamId: string, projectId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.teamId, teamId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.role, "owner"),
      ),
    );
  return row?.n ?? 0;
}

/** The project's explicit role set after a change (audit GV4: counts, never who). */
async function roleCounts(tx: KobeTx, teamId: string, projectId: string) {
  const rows = await tx
    .select({ role: projectMembers.role, n: count() })
    .from(projectMembers)
    .where(and(eq(projectMembers.teamId, teamId), eq(projectMembers.projectId, projectId)))
    .groupBy(projectMembers.role);
  const of = (role: ProjectMemberRole) => rows.find((r) => r.role === role)?.n ?? 0;
  return { owner: of("owner"), editor: of("editor") };
}

async function currentRole(tx: KobeTx, teamId: string, projectId: string, userId: string) {
  const [row] = await tx
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.teamId, teamId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    );
  return row?.role;
}

export async function addMember(
  tx: KobeTx,
  viewer: Viewer,
  projectId: string,
  member: { userId: string; role: ProjectMemberRole },
): Promise<Outcome<ProjectMember>> {
  if (!(await usersInTeam(tx, viewer.teamId, [member.userId]))) return fail("not_in_team");
  if ((await currentRole(tx, viewer.teamId, projectId, member.userId)) !== undefined) {
    return fail("already_exists");
  }
  const [row] = await tx
    .insert(projectMembers)
    .values({
      teamId: viewer.teamId,
      projectId,
      userId: member.userId,
      role: member.role,
      addedBy: viewer.userId,
    })
    .returning();
  if (!row) throw new Error("project member insert returned no row");
  await recordAudit(tx, {
    action: "project.member_added",
    teamId: viewer.teamId,
    target: { projectId, userId: member.userId, role: member.role },
  });
  return {
    ok: true,
    value: {
      user_id: row.userId,
      role: row.role,
      added_at: row.addedAt.toISOString(),
    },
  };
}

/** Sets a role; a workspace member without a row (an implicit reader, RV1) gets one. */
export async function setMemberRole(
  tx: KobeTx,
  viewer: Viewer,
  access: ProjectAccess,
  userId: string,
  role: ProjectMemberRole,
): Promise<Outcome<ProjectMember>> {
  const projectId = access.project.id;
  const before = await currentRole(tx, viewer.teamId, projectId, userId);
  if (before === undefined) return addMember(tx, viewer, projectId, { userId, role });
  if (
    before === "owner" &&
    role !== "owner" &&
    (await ownerCount(tx, viewer.teamId, projectId)) <= 1
  ) {
    return fail("last_owner");
  }
  const [row] = await tx
    .update(projectMembers)
    .set({ role })
    .where(
      and(
        eq(projectMembers.teamId, viewer.teamId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    )
    .returning();
  if (!row) throw new Error("project member update returned no row");
  await recordAudit(tx, {
    action: "project.member_role_changed",
    teamId: viewer.teamId,
    target: {
      projectId,
      userId,
      from: before,
      to: role,
      roles: await roleCounts(tx, viewer.teamId, projectId),
    },
  });
  return {
    ok: true,
    value: {
      user_id: row.userId,
      role: row.role,
      added_at: row.addedAt.toISOString(),
    },
  };
}

export async function removeMember(
  tx: KobeTx,
  viewer: Viewer,
  projectId: string,
  userId: string,
): Promise<Outcome<null>> {
  const before = await currentRole(tx, viewer.teamId, projectId, userId);
  if (before === undefined) return fail("not_found");
  if (before === "owner" && (await ownerCount(tx, viewer.teamId, projectId)) <= 1) {
    return fail("last_owner");
  }
  await tx
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.teamId, viewer.teamId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    );
  // The removed member's remembered approvals in this project's threads end for good (S2).
  await endUnreachableThreadRules(tx, viewer.teamId);
  await recordAudit(tx, {
    action: "project.member_removed",
    teamId: viewer.teamId,
    target: { projectId, userId },
  });
  return { ok: true, value: null };
}

/**
 * Hands the project to `toUserId` (PR5, `POST /v1/projects/{id}/owner`; owners and team admins,
 * under the project row lock). The target, who must be in the workspace and active (a deactivated
 * account is refused `user_deactivated`, 422 `invalid_input`), becomes an owner. When
 * the caller is an owner handing over to someone else, the caller becomes an editor
 * (`previous_owner_user_id` = the caller); a team admin who is not an owner assigns an owner and
 * nobody is demoted (`previous_owner_user_id` null). Audited `project.owner_transferred`.
 */
export async function transferOwner(
  tx: KobeTx,
  viewer: Viewer,
  access: ProjectAccess,
  toUserId: string,
): Promise<Outcome<TransferOwnerResponse>> {
  const projectId = access.project.id;
  if (!(await usersInTeam(tx, viewer.teamId, [toUserId]))) return fail("not_in_team");
  const [inactive] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, toUserId), isNotNull(users.deactivatedAt)));
  if (inactive) return fail("user_deactivated");
  const callerRole = await currentRole(tx, viewer.teamId, projectId, viewer.userId);
  const targetRole = await currentRole(tx, viewer.teamId, projectId, toUserId);
  if (targetRole === undefined) {
    await tx.insert(projectMembers).values({
      teamId: viewer.teamId,
      projectId,
      userId: toUserId,
      role: "owner",
      addedBy: viewer.userId,
    });
  } else if (targetRole !== "owner") {
    await setRole(tx, viewer.teamId, projectId, toUserId, "owner");
  }
  const handover = callerRole === "owner" && toUserId !== viewer.userId;
  if (handover) await setRole(tx, viewer.teamId, projectId, viewer.userId, "editor");
  const fromUserId = handover ? viewer.userId : null;
  await recordAudit(tx, {
    action: "project.owner_transferred",
    teamId: viewer.teamId,
    target: { projectId, toUserId, fromUserId },
  });
  return {
    ok: true,
    value: { project_id: projectId, owner_user_id: toUserId, previous_owner_user_id: fromUserId },
  };
}

async function setRole(
  tx: KobeTx,
  teamId: string,
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
): Promise<void> {
  await tx
    .update(projectMembers)
    .set({ role })
    .where(
      and(
        eq(projectMembers.teamId, teamId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    );
}
