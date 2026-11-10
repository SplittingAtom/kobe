import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { isLegalHoldViolation, withTeam, type KobeTx } from "@kobe/db";
import {
  addProjectMemberRequestSchema,
  createProjectRequestSchema,
  importProjectFileRequestSchema,
  listProjectsQuerySchema,
  PROJECT_FILE_MAX_BYTES,
  projectFileUploadFieldsSchema,
  transferOwnerRequestSchema,
  updateProjectMemberRequestSchema,
  updateProjectRequestSchema,
  type ProjectAction,
} from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { decide, loadAccess, type ProjectAccess } from "../projects/access.js";
import { importProjectFile, type ImportRefusal } from "../projects/import.js";
import { endCheckoutsWithoutEditInTx } from "../projects/offboard.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import {
  listProjectFiles,
  removeProjectFile,
  uploadProjectFile,
  type ProjectFileFailure,
} from "../projects/files.js";
import {
  addMember,
  createProject,
  deleteProject,
  listMembers,
  listOwnerless,
  listProjects,
  removeMember,
  setMemberRole,
  toProject,
  transferOwner,
  updateProject,
  type ProjectFailure,
} from "../projects/repository.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { openUpload } from "../uploads/parse.js";
import { DEFAULT_TEAM_MAX_OBJECTS, DEFAULT_UPLOAD_SETTINGS } from "../uploads/settings.js";

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
    "The default agent must be a published, active team or gallery agent; personal agents can't be a project default.",
  ],
  archived: [409, "archived", "The project is archived."],
  in_use: [409, "project_in_use", "The project still has content."],
  legal_hold: [409, "forbidden", "The team is under a legal hold: the project's history stays."],
  user_deactivated: [
    422,
    "invalid_input",
    "That account is deactivated; make an active member the owner.",
  ],
} as const satisfies Record<ProjectFailure, readonly [number, string, string]>;

function failure(c: Context, error: ProjectFailure, detail?: string) {
  const [status, code, message] = ERRORS[error];
  return c.json(
    { code, message: detail === undefined ? message : `${message} Remove first: ${detail}.` },
    status,
  );
}

const FILE_ERRORS = {
  invalid_path: [422, "invalid_input", "That is not a valid file name or folder."],
  already_exists: [409, "already_exists", "The project already has a file with that name."],
  file_too_large: [413, "file_too_large", "That file is larger than a project file may be."],
  quota_exceeded: [507, "quota_exceeded", "Your team has no storage left for this file."],
  object_budget: [
    507,
    "quota_exceeded",
    "Your workspace holds as many stored objects as its budget allows.",
  ],
  project_full: [507, "quota_exceeded", "The project already holds the most files it can."],
  archived: [409, "archived", "The project is archived."],
  storage_failed: [503, "storage_unavailable", "File storage is not available. Try again."],
} as const satisfies Record<ProjectFileFailure, readonly [number, string, string]>;

/** Add to project (KOBE-585): the refusals before the copy; the rest are {@link FILE_ERRORS}. */
const IMPORT_ERRORS = {
  project_not_found: [404, "not_found", "No project with that id is available to you."],
  source_not_found: [404, "not_found", "No such artifact version or file is available to you."],
  forbidden: [403, "forbidden", "You can't add that to this project."],
  invalid_name: [422, "invalid_input", "That is not a valid file name."],
  content_unavailable: [503, "storage_unavailable", "File storage is not available. Try again."],
  content_missing: [503, "content_missing", "The file's saved copy is missing; try again shortly."],
} as const satisfies Record<ImportRefusal, readonly [number, string, string]>;

/** Multipart framing allowed on top of the file itself. */
const MULTIPART_OVERHEAD = 64 * 1024;

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
 * Projects API (KOBE-161 = 57c of KOBE-57, spec D23; Workspaces PR1-PR5, KOBE-578; contract
 * `packages/protocol/src/projects.ts` and `project-commits.ts`). Every decision is
 * `projectPermissions` through `projects/access.ts` (`decide`, `loadAccess`): contributors and team
 * admins create (and own what they create); readers view and converse; editors also upload and
 * remove files; owners manage the project and its people; team admins act as owners everywhere.
 * Every workspace member views every project of the workspace (RV1, KOBE-587); anyone outside
 * the workspace gets 404, as if it did not exist. Instructions are never written to the audit log.
 */
export function projectRoutes(
  deps: ServerDeps,
  sync?: WorkspaceSync,
): Hono<{ Variables: TeamVariables }> {
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
    if (!decide(c.get("team").role, undefined).can.create) return failure(c, "forbidden");
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
    const query = listProjectsQuerySchema.safeParse(c.req.query());
    if (!query.success)
      return invalidRequest(c, "role may only be editor; include_archived true or false.");
    const viewer = viewerOf(c);
    const list = await withTeam(db, viewer.teamId, (tx) =>
      listProjects(tx, viewer, {
        includeArchived: query.data.include_archived ?? false,
        teamRole: c.get("team").role,
        editorOnly: query.data.role === "editor",
      }),
    );
    return c.json({ projects: list });
  });

  /** PR5: projects whose only owner left the workspace, for team admins ("No owner: assign one"). */
  app.get("/no-owner", async (c) => {
    if (!decide(c.get("team").role, undefined).can.manage_members) {
      return failure(c, "forbidden");
    }
    const query = listProjectsQuerySchema.safeParse(c.req.query());
    if (!query.success || query.data.role !== undefined) {
      return invalidRequest(c, "Only include_archived (true or false) is accepted.");
    }
    const teamId = viewerOf(c).teamId;
    const list = await withTeam(db, teamId, (tx) =>
      listOwnerless(tx, teamId, { includeArchived: query.data.include_archived ?? false }),
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
      c.json({ members: await listMembers(tx, access.project.teamId, access.project.id) }),
    ),
  );

  app.post("/:id/members", async (c) => {
    const body = await parseBody(c, addProjectMemberRequestSchema);
    if (!body)
      return invalidRequest(
        c,
        "Give user_id and optionally role (owner or editor; every member already reads).",
      );
    const res = await withProject(c, "manage_members", async (tx, access) => {
      const added = await addMember(tx, viewerOf(c), access.project.id, {
        userId: body.user_id,
        role: body.role ?? "editor",
      });
      return added.ok ? c.json(added.value, 201) : failure(c, added.error);
    });
    if (res.ok) await deps.projectMounts.reconcileUser(viewerOf(c).teamId, body.user_id);
    return res;
  });

  /** PR5: hand the project to another member of the workspace (owners and team admins). */
  app.post("/:id/owner", async (c) => {
    const body = await parseBody(c, transferOwnerRequestSchema);
    if (!body) return invalidRequest(c, "Give user_id: the member who becomes owner.");
    return withProject(c, "manage_members", async (tx, access) => {
      const moved = await transferOwner(tx, viewerOf(c), access, body.user_id);
      return moved.ok ? c.json(moved.value) : failure(c, moved.error);
    });
  });

  const memberParam = (c: ProjectContext) => idParam.safeParse(c.req.param("user_id"));

  app.patch("/:id/members/:user_id", async (c) => {
    const body = await parseBody(c, updateProjectMemberRequestSchema);
    const user = memberParam(c);
    if (!body || !user.success) {
      return invalidRequest(
        c,
        "Give role (owner or editor). To make someone a reader, remove their row.",
      );
    }
    const res = await withProject(c, "manage_members", async (tx, access) => {
      const changed = await setMemberRole(tx, viewerOf(c), access, user.data, body.role);
      if (!changed.ok) return failure(c, changed.error);
      // Owner and editor both edit; kept so a role that cannot edit always ends a checkout (KOBE-579).
      await endCheckoutsWithoutEditInTx(tx, viewerOf(c).teamId, user.data);
      return c.json(changed.value);
    });
    if (res.ok) await deps.projectMounts.reconcileUser(viewerOf(c).teamId, user.data);
    return res;
  });

  app.delete("/:id/members/:user_id", async (c) => {
    const user = memberParam(c);
    if (!user.success) return failure(c, "not_found");
    const res = await withProject(c, "manage_members", async (tx, access) => {
      const removed = await removeMember(tx, viewerOf(c), access.project.id, user.data);
      if (!removed.ok) return failure(c, removed.error);
      // An implicit reader (or no one) now: a checkout of theirs ends (KOBE-579).
      await endCheckoutsWithoutEditInTx(tx, viewerOf(c).teamId, user.data);
      return c.body(null, 204);
    });
    // Still an implicit reader (RV1): the user's workspace is brought in line (a checkout ended).
    if (res.ok) await deps.projectMounts.reconcileUser(viewerOf(c).teamId, user.data);
    return res;
  });

  // ------------------------------------------------------------------ files (KOBE-162)

  const fileFailure = (c: ProjectContext, error: ProjectFileFailure) => {
    const [status, code, message] = FILE_ERRORS[error];
    // GV2: a quota refusal names the limit (bytes or objects).
    const limit =
      error === "quota_exceeded" ? "bytes" : error === "object_budget" ? "objects" : undefined;
    return c.json({ code, message, ...(limit === undefined ? {} : { limit }) }, status);
  };

  app.get("/:id/files", (c) =>
    withProject(c, "view", async (tx, access) =>
      c.json({ files: await listProjectFiles(tx, access.project.teamId, access.project.id) }),
    ),
  );

  app.post("/:id/files", async (c) => {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      return c.json({ code: "invalid_input", message: "Send multipart/form-data." }, 415);
    }
    const settings = deps.uploads ?? DEFAULT_UPLOAD_SETTINGS;
    const maxBytes = Math.min(PROJECT_FILE_MAX_BYTES, settings.maxFileBytes);
    const length = Number(c.req.header("content-length") ?? "NaN");
    if (!Number.isSafeInteger(length) || length < 0) {
      return c.json({ code: "invalid_input", message: "Content-Length is required." }, 411);
    }
    if (length > maxBytes + MULTIPART_OVERHEAD) return fileFailure(c, "file_too_large");
    const body = c.req.raw.body;
    if (!body) return invalidRequest(c, "No file was sent.");
    // The permission is checked before a byte is read (404/403 first, then the stream).
    const viewer = viewerOf(c);
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return failure(c, "not_found");
    const access = await withTeam(db, viewer.teamId, (tx) => loadAccess(tx, viewer, id.data));
    if (!access) return failure(c, "not_found");
    if (!access.can.edit) return failure(c, "forbidden");
    const opened = await openUpload(
      c.req.header("content-type"),
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      projectFileUploadFieldsSchema,
    );
    if (!opened.ok) return invalidRequest(c, opened.reason);
    const { upload } = opened;
    const result = await uploadProjectFile(
      {
        db,
        blobs: deps.blobs,
        maxFileBytes: settings.maxFileBytes,
        teamQuotaDefaultBytes: settings.defaultQuotaBytes,
        teamMaxObjectsDefault: settings.defaultMaxObjects ?? DEFAULT_TEAM_MAX_OBJECTS,
      },
      { teamId: viewer.teamId, projectId: access.project.id, userId: viewer.userId },
      {
        folder: upload.fields.path,
        name: upload.name,
        declaredMime: upload.declaredMime,
        body: upload.file,
      },
    );
    if (!result.ok) return fileFailure(c, result.error);
    await deps.projectMounts.reconcileProject(viewer.teamId, access.project.id);
    return c.json(result.file, 201);
  });

  /** Add to project (KOBE-585; `projects/import.ts`): an artifact version or own file, copied. */
  app.post("/:id/files/import", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return failure(c, "not_found");
    const body = await parseBody(c, importProjectFileRequestSchema);
    if (!body) {
      return invalidRequest(
        c,
        "Give source (an artifact version or a workspace path), and optionally folder and name.",
      );
    }
    const settings = deps.uploads ?? DEFAULT_UPLOAD_SETTINGS;
    const viewer = viewerOf(c);
    const result = await importProjectFile(
      {
        db,
        blobs: deps.blobs,
        sync,
        maxFileBytes: settings.maxFileBytes,
        teamQuotaDefaultBytes: settings.defaultQuotaBytes,
        teamMaxObjectsDefault: settings.defaultMaxObjects ?? DEFAULT_TEAM_MAX_OBJECTS,
      },
      viewer,
      id.data,
      body,
    );
    if (!result.ok) {
      if (result.error in IMPORT_ERRORS) {
        const [status, code, message] = IMPORT_ERRORS[result.error as ImportRefusal];
        return c.json({ code, message }, status);
      }
      return fileFailure(c, result.error as ProjectFileFailure);
    }
    await deps.projectMounts.reconcileProject(viewer.teamId, id.data);
    return c.json(result.file, 201);
  });

  app.delete("/:id/files/:file_id", async (c) => {
    const fileId = idParam.safeParse(c.req.param("file_id"));
    if (!fileId.success) return failure(c, "not_found");
    let key: string | undefined;
    const res = await withProject(c, "edit", async (tx, access) => {
      try {
        // A savepoint: the hold guard (KH001) refuses the delete without ending the transaction.
        key = await tx.transaction((sp) =>
          removeProjectFile(
            sp,
            viewerOf(c).userId,
            access.project.teamId,
            access.project.id,
            fileId.data,
          ),
        );
      } catch (err) {
        if (isLegalHoldViolation(err)) {
          return c.json(
            { code: "forbidden", message: "The team is under a legal hold: files stay." },
            409,
          );
        }
        throw err;
      }
      return key === undefined ? failure(c, "not_found") : c.body(null, 204);
    });
    // The object stays (the previous commit names it; KOBE-579): only the mounts change.
    if (res.ok && key !== undefined) {
      await deps.projectMounts.reconcileProject(viewerOf(c).teamId, c.req.param("id") ?? "");
    }
    return res;
  });

  return app;
}
