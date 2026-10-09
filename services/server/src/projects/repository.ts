import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  memoryDocs,
  projectFiles,
  projectMembers,
  projects,
  teamMembers,
  threads,
  type KobeTx,
} from "@kobe/db";
import type {
  CreateProjectRequest,
  Project,
  ProjectMember,
  ProjectRole,
  UpdateProjectRequest,
} from "@kobe/protocol";
import { canPinAgent, findPinnableAgent } from "../agents/versions.js";
import { recordAudit } from "../audit/record.js";
import { effectiveRole, type ProjectAccess, type ProjectRow } from "./access.js";
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
  | "in_use";

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
    members_mode: row.membersMode,
    my_role: myRole ?? null,
    file_count: files?.n ?? 0,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    archived_at: row.archivedAt?.toISOString() ?? null,
  };
}

/** A default agent must be one the team can see and start threads with (team, personal, gallery). */
async function validAgent(tx: KobeTx, viewer: Viewer, agentId: string): Promise<boolean> {
  const agent = await findPinnableAgent(tx, viewer, agentId);
  return agent !== null && canPinAgent(agent);
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
      membersMode: body.members_mode ?? "team",
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
      role: "member" as const,
      addedBy: viewer.userId,
    })),
  ]);
  await recordAudit(tx, {
    action: "project.created",
    teamId: viewer.teamId,
    target: { projectId: row.id, membersMode: row.membersMode },
  });
  return { ok: true, value: { row } };
}

/** Projects the caller can view (members, or every project for a team admin). */
export async function listProjects(
  tx: KobeTx,
  viewer: Viewer,
  options: { includeArchived: boolean; admin: boolean },
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
  for (const { project, role } of rows) {
    const mine = effectiveRole(project.membersMode, role ?? undefined);
    if (mine === undefined && !options.admin) continue;
    out.push(await toProject(tx, viewer.teamId, project, mine));
  }
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
      ...(body.members_mode === undefined ? {} : { membersMode: body.members_mode }),
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
  await tx
    .delete(projects)
    .where(and(eq(projects.teamId, viewer.teamId), eq(projects.id, projectId)));
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
  member: { userId: string; role: ProjectRole },
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
    value: { user_id: row.userId, role: row.role, added_at: row.addedAt.toISOString() },
  };
}

/** Sets a role; in mode `team` an implicit member without a row gets one (to be made owner). */
export async function setMemberRole(
  tx: KobeTx,
  viewer: Viewer,
  access: ProjectAccess,
  userId: string,
  role: ProjectRole,
): Promise<Outcome<ProjectMember>> {
  const projectId = access.project.id;
  const before = await currentRole(tx, viewer.teamId, projectId, userId);
  if (before === undefined) {
    if (access.project.membersMode !== "team") return fail("not_found");
    const added = await addMember(tx, viewer, projectId, { userId, role });
    return added;
  }
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
    target: { projectId, userId, from: before, to: role },
  });
  return {
    ok: true,
    value: { user_id: row.userId, role: row.role, added_at: row.addedAt.toISOString() },
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
  await recordAudit(tx, {
    action: "project.member_removed",
    teamId: viewer.teamId,
    target: { projectId, userId },
  });
  return { ok: true, value: null };
}
