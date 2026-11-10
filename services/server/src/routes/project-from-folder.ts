import type { Context } from "hono";
import { Hono } from "hono";
import { withTeam } from "@kobe/db";
import { PROJECT_FILES_MAX, promoteFolderRequestSchema } from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { decide, loadAccess } from "../projects/access.js";
import { promoteFolder, type PromoteResult } from "../projects/promote.js";
import { toProject } from "../projects/repository.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { DEFAULT_TEAM_MAX_OBJECTS, DEFAULT_UPLOAD_SETTINGS } from "../uploads/settings.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const fail = (c: Ctx, status: number, code: string, message: string, extra: object = {}) =>
  c.json({ code, message, ...extra }, status as 400);

/** The refusals of {@link promoteFolder} as the REST contract answers them (PF4: said clearly). */
function refusal(c: Ctx, r: Extract<PromoteResult, { status: "refused" }>): Response {
  const named = r.path === undefined ? "" : ` (${r.path})`;
  switch (r.error) {
    case "not_found":
      return fail(c, 404, "not_found", "No such folder in My files.");
    case "outside_my_files":
      return fail(
        c,
        422,
        "invalid_input",
        "Only a folder in My files can become a project (not uploads or a project's folder).",
      );
    case "not_a_folder":
      return fail(c, 422, "invalid_input", "That is a file, not a folder.");
    case "empty_folder":
      return fail(
        c,
        422,
        "invalid_input",
        "This folder is empty; create the project from Projects instead.",
      );
    case "too_many_files":
      return fail(
        c,
        422,
        "invalid_input",
        `A project holds at most ${PROJECT_FILES_MAX} files; this folder has more.`,
      );
    case "file_too_large":
      return fail(c, 413, "file_too_large", `A file is larger than a project file may be${named}.`);
    case "invalid_path":
      return fail(c, 422, "invalid_input", `A file name can't be used in a project${named}.`);
    case "conflict_file":
      return fail(
        c,
        422,
        "invalid_input",
        `Resolve the conflict copy first: keep what you need and delete it${named}.`,
      );
    case "quota_exceeded":
      return fail(
        c,
        507,
        "quota_exceeded",
        r.limit === "objects"
          ? "The project would pass your workspace's object budget."
          : "The project would pass your workspace's storage quota.",
        { limit: r.limit ?? "bytes" },
      );
    case "legal_hold":
      return fail(
        c,
        409,
        "legal_hold",
        "This workspace is under a legal hold; its files can't move into a project.",
      );
    case "slug_taken":
      return fail(c, 409, "slug_taken", "Too many projects use a name like that; pick another.");
    case "changed":
      c.header("Retry-After", "2");
      return fail(c, 503, "busy", "The folder changed while the project was made. Try again.");
    case "storage_failed":
      return fail(c, 503, "storage_unavailable", "File storage is not available. Try again.");
  }
}

function isSlugConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string } };
  const cause = (e.cause ?? e) as { code?: string; constraint?: string };
  return cause.code === "23505" && cause.constraint === "projects_slug_unique";
}

/**
 * `POST /v1/projects/from-folder` (KOBE-586, projects-in-conversations PF1-PF6; contract
 * `promoteFolderRequestSchema`): a folder of the caller's own My files becomes a project they
 * own, in one commit, then leaves My files and mounts for them (`projects/promote.ts`). Team
 * admins and contributors only (`team.projects.create`, PR4); members get 403.
 */
export function projectFromFolderRoutes(
  deps: ServerDeps,
  sync?: WorkspaceSync,
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.read"));
  const settings = () => deps.uploads ?? DEFAULT_UPLOAD_SETTINGS;

  app.post("/from-folder", async (c) => {
    const body = await parseBody(c, promoteFolderRequestSchema);
    if (!body) return invalidRequest(c, "Give the folder's path and a project name (1-100).");
    if (!decide(c.get("team").role, undefined).can.create) {
      return fail(c, 403, "forbidden", "Only team admins and contributors create projects.");
    }
    const owner = { teamId: c.get("team").id, userId: c.get("user").id };
    let result: PromoteResult;
    try {
      result = await promoteFolder(
        {
          db,
          blobs: deps.blobs,
          sync,
          mounts: deps.projectMounts,
          limits: {
            quotaDefaultBytes: settings().defaultQuotaBytes,
            maxObjectsDefault: settings().defaultMaxObjects ?? DEFAULT_TEAM_MAX_OBJECTS,
            maxFileBytes: settings().maxFileBytes,
          },
          log: logger,
        },
        owner,
        body,
      );
    } catch (err) {
      if (isSlugConflict(err)) {
        return fail(c, 409, "slug_taken", "Another project took that name just now. Try again.");
      }
      throw err;
    }
    if (result.status === "refused") return refusal(c, result);
    const id = result.project.id;
    const project = await withTeam(db, owner.teamId, async (tx) => {
      const access = await loadAccess(tx, owner, id);
      return access ? toProject(tx, owner.teamId, access.project, access.role) : undefined;
    });
    if (!project) return fail(c, 404, "not_found", "No project with that id is available to you.");
    return c.json(project, 201);
  });

  return app;
}
