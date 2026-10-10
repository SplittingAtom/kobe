import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { isLegalHoldViolation, withTeam, type KobeTx } from "@kobe/db";
import {
  addProjectMemberRequestSchema,
  createProjectRequestSchema,
  PROJECT_FILE_MAX_BYTES,
  projectFileUploadFieldsSchema,
  projectPermissions,
  updateProjectMemberRequestSchema,
  updateProjectRequestSchema,
  type ProjectAction,
} from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { loadAccess, type ProjectAccess } from "../projects/access.js";
import {
  deleteProjectObject,
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
  listProjects,
  removeMember,
  setMemberRole,
  toProject,
  updateProject,
  type ProjectFailure,
} from "../projects/repository.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { openUpload } from "../uploads/parse.js";
import { DEFAULT_UPLOAD_SETTINGS } from "../uploads/settings.js";

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
  quota_exceeded: [413, "quota_exceeded", "Your team has no storage left for this file."],
  project_full: [413, "quota_exceeded", "The project already holds the most files it can."],
  archived: [409, "archived", "The project is archived."],
  storage_failed: [503, "storage_unavailable", "File storage is not available. Try again."],
} as const satisfies Record<ProjectFileFailure, readonly [number, string, string]>;

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
    const res = await withProject(c, "manage", async (tx, access) => {
      const updated = await updateProject(tx, viewerOf(c), access, body);
      if (!updated.ok) return failure(c, updated.error);
      return c.json(await toProject(tx, access.project.teamId, updated.value.row, access.role));
    });
    // A new members mode changes who the files are mounted for.
    if (res.ok && body.members_mode !== undefined) {
      await deps.projectMounts.reconcileTeam(viewerOf(c).teamId);
    }
    return res;
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
    const res = await withProject(c, "manage_members", async (tx, access) => {
      const added = await addMember(tx, viewerOf(c), access.project.id, {
        userId: body.user_id,
        role: body.role ?? "member",
      });
      return added.ok ? c.json(added.value, 201) : failure(c, added.error);
    });
    if (res.ok) await deps.projectMounts.reconcileUser(viewerOf(c).teamId, body.user_id);
    return res;
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

  app.delete("/:id/members/:user_id", async (c) => {
    const user = memberParam(c);
    if (!user.success) return failure(c, "not_found");
    const res = await withProject(c, "manage_members", async (tx, access) => {
      const removed = await removeMember(tx, viewerOf(c), access.project.id, user.data);
      return removed.ok ? c.body(null, 204) : failure(c, removed.error);
    });
    // No longer a member (mode `selected`) or still an implicit one (mode `team`): the user's
    // workspace is brought in line either way.
    if (res.ok) await deps.projectMounts.reconcileUser(viewerOf(c).teamId, user.data);
    return res;
  });

  // ------------------------------------------------------------------ files (KOBE-162)

  const fileFailure = (c: ProjectContext, error: ProjectFileFailure) => {
    const [status, code, message] = FILE_ERRORS[error];
    return c.json({ code, message }, status);
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
    if (!access.can.manage) return failure(c, "forbidden");
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

  app.delete("/:id/files/:file_id", async (c) => {
    const fileId = idParam.safeParse(c.req.param("file_id"));
    if (!fileId.success) return failure(c, "not_found");
    let key: string | undefined;
    const res = await withProject(c, "manage", async (tx, access) => {
      try {
        key = await removeProjectFile(
          tx,
          viewerOf(c).userId,
          access.project.teamId,
          access.project.id,
          fileId.data,
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
    if (res.ok && key !== undefined) {
      // Mounts first, so no workspace still names the object when it goes. If any workspace
      // could not be updated, the object stays: a row never points at a deleted object (the
      // next run start of that member drops the row; the object is then an unreferenced orphan).
      const clean = await deps.projectMounts.reconcileProject(
        viewerOf(c).teamId,
        c.req.param("id") ?? "",
      );
      if (clean) await deleteProjectObject(deps.blobs, key);
    }
    return res;
  });

  return app;
}
