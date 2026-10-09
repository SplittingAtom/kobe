import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { withTeam, type KobeTx } from "@kobe/db";
import {
  addProjectMemberRequestSchema,
  createProjectRequestSchema,
  projectPermissions,
  updateProjectMemberRequestSchema,
  updateProjectRequestSchema,
  type ProjectAction,
} from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { loadAccess, type ProjectAccess } from "../projects/access.js";
import {
  addMember,
  createProject,
  deleteProject,
  listMembers,
  listProjects,
  removeMember,
  setMemberRole,
  toProject,
  updateProject,
  type ProjectFailure,
} from "../projects/repository.js";
import { invalidRequest, parseBody } from "../teams/http.js";

type ProjectContext = Context<{ Variables: TeamVariables }>;

const ERRORS = {
  not_found: [404, "not_found", "No project with that id is available to you."],
  forbidden: [403, "forbidden", "Your project role doesn't allow that."],
  slug_taken: [409, "slug_taken", "Another project in this team already uses that slug."],
  already_exists: [409, "already_exists", "That user is already a member of the project."],
  last_owner: [
    409,
    "last_owner",
    "A project needs at least one owner. Make someone else owner first.",
  ],
  not_in_team: [422, "not_in_team", "Every member must belong to this team."],
  invalid_agent: [
    422,
    "invalid_input",
    "The default agent must be an agent you can use that is published and active.",
  ],
  archived: [409, "archived", "The project is archived."],
  in_use: [409, "project_in_use", "The project still has content."],
} as const satisfies Record<ProjectFailure, readonly [number, string, string]>;

function failure(c: Context, error: ProjectFailure, detail?: string) {
  const [status, code, message] = ERRORS[error];
  return c.json(
    { code, message: detail === undefined ? message : `${message} Remove first: ${detail}.` },
    status,
  );
}

const idParam = z.uuid();
const SLUG_UNIQUE = "projects_slug_unique";

function isSlugConflict(err: unknown): boolean {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const cause = e.cause ?? e;
  return cause.code === "23505" && cause.constraint === SLUG_UNIQUE;
}

/**
 * Projects API (KOBE-161 = 57c of KOBE-57, spec D23; contract `packages/protocol/src/projects.ts`).
 * Roles come from `projectPermissions` only: Builders create (and own what they create), owners
 * manage their project and its members, team admins manage every project of the team, members use
 * it. Anyone who may not view a project gets 404, as if it did not exist. Instructions are never
 * written to the audit log. Files and thread sharing are KOBE-162/163.
 */
export function projectRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.read"));

  const viewerOf = (c: ProjectContext) => ({ teamId: c.get("team").id, userId: c.get("user").id });

  /** Runs `fn` with the caller's access to `:id` (404 if none, 403 if `action` is not allowed). */
  const withProject = async (
    c: ProjectContext,
    action: ProjectAction,
    fn: (tx: KobeTx, access: ProjectAccess) => Promise<Response>,
  ): Promise<Response> => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return failure(c, "not_found");
    const viewer = viewerOf(c);
    try {
      return await withTeam(db, viewer.teamId, async (tx) => {
        const access = await loadAccess(tx, viewer, id.data, { lock: action !== "view" });
        if (!access) return failure(c, "not_found");
        if (!access.can[action]) return failure(c, "forbidden");
        return fn(tx, access);
      });
    } catch (err) {
      if (isSlugConflict(err)) return failure(c, "slug_taken");
      throw err;
    }
  };

  app.post("/", async (c) => {
    const body = await parseBody(c, createProjectRequestSchema);
    if (!body)
      return invalidRequest(c, "Check the project fields (name, slug, instructions up to 8 KiB).");
    if (!projectPermissions(c.get("team").role, undefined).create) return failure(c, "forbidden");
    const viewer = viewerOf(c);
    try {
      return await withTeam(db, viewer.teamId, async (tx) => {
        const created = await createProject(tx, viewer, body);
        if (!created.ok) return failure(c, created.error);
        const { row } = created.value;
        return c.json(await toProject(tx, viewer.teamId, row, "owner"), 201);
      });
    } catch (err) {
      if (isSlugConflict(err)) return failure(c, "slug_taken");
      throw err;
    }
  });

  app.get("/", async (c) => {
    const viewer = viewerOf(c);
    const includeArchived = c.req.query("include_archived") === "true";
    const admin = projectPermissions(c.get("team").role, undefined).manage;
    const list = await withTeam(db, viewer.teamId, (tx) =>
      listProjects(tx, viewer, { includeArchived, admin }),
    );
    return c.json({ projects: list });
  });

  app.get("/:id", (c) =>
    withProject(c, "view", async (tx, a) =>
      c.json(await toProject(tx, a.project.teamId, a.project, a.role)),
    ),
  );

  app.patch("/:id", async (c) => {
    const body = await parseBody(c, updateProjectRequestSchema);
    if (!body) return invalidRequest(c, "Check the project fields (instructions up to 8 KiB).");
    return withProject(c, "manage", async (tx, access) => {
      const updated = await updateProject(tx, viewerOf(c), access, body);
      if (!updated.ok) return failure(c, updated.error);
      return c.json(await toProject(tx, access.project.teamId, updated.value.row, access.role));
    });
  });

  app.delete("/:id", (c) =>
    withProject(c, "manage", async (tx, access) => {
      const deleted = await deleteProject(tx, viewerOf(c), access.project.id);
      return deleted.ok ? c.body(null, 204) : failure(c, deleted.error, deleted.detail);
    }),
  );

  app.get("/:id/members", (c) =>
    withProject(c, "view", async (tx, access) =>
      c.json({
        members_mode: access.project.membersMode,
        members: await listMembers(tx, access.project.teamId, access.project.id),
      }),
    ),
  );

  app.post("/:id/members", async (c) => {
    const body = await parseBody(c, addProjectMemberRequestSchema);
    if (!body) return invalidRequest(c, "Give user_id and optionally role (owner or member).");
    return withProject(c, "manage_members", async (tx, access) => {
      const added = await addMember(tx, viewerOf(c), access.project.id, {
        userId: body.user_id,
        role: body.role ?? "member",
      });
      return added.ok ? c.json(added.value, 201) : failure(c, added.error);
    });
  });

  const memberParam = (c: ProjectContext) => idParam.safeParse(c.req.param("user_id"));

  app.patch("/:id/members/:user_id", async (c) => {
    const body = await parseBody(c, updateProjectMemberRequestSchema);
    const user = memberParam(c);
    if (!body || !user.success) return invalidRequest(c, "Give role (owner or member).");
    return withProject(c, "manage_members", async (tx, access) => {
      const changed = await setMemberRole(tx, viewerOf(c), access, user.data, body.role);
      return changed.ok ? c.json(changed.value) : failure(c, changed.error);
    });
  });

  app.delete("/:id/members/:user_id", (c) => {
    const user = memberParam(c);
    if (!user.success) return failure(c, "not_found");
    return withProject(c, "manage_members", async (tx, access) => {
      const removed = await removeMember(tx, viewerOf(c), access.project.id, user.data);
      return removed.ok ? c.body(null, 204) : failure(c, removed.error);
    });
  });

  return app;
}
