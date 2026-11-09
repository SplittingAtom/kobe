import { z } from "zod";
import type { teamRoleSchema } from "./common.js";
import {
  idSchema,
  threadTitleSchema,
  timestampSchema,
  utf8ByteLength,
  uuidSchema,
} from "./common.js";
import { sha256HexSchema, workspacePathSchema } from "./sandbox-wire/workspace-sync.js";
import { PROJECT_COMMIT_ERROR_CODES, commitProjectToolInputSchema } from "./project-commits.js";
import { uploadFileNameSchema } from "./uploads.js";

/**
 * Projects contract (KOBE-159 = 57a of KOBE-57, spec D23; notes in docs/ledger/KOBE-159.md).
 * Additive: an agent without {@link CAPABILITY_PROJECTS} never registers `commit_project`;
 * an old `run.start` has no `project` field; no existing shape changes.
 *
 * A project lives inside one team: name, instructions, default agent, files (S3), memory scope
 * `project` (memory.ts, keyed by (team_id, project_id)) and members (default: the whole team).
 *
 * Roles. Team role (`teamRoleSchema`) x project role ({@link projectRoleSchema}); see
 * {@link projectPermissions}. Builders create projects (and become `owner`); owners manage their
 * project; team admins manage every project of their team.
 *
 * Threads. A thread created in a project is private to its author. The author may share it to the
 * project ({@link shareThreadRequestSchema}); members then see it read-only (no send, no approvals,
 * no stop) and may fork it ({@link forkThreadRequestSchema}); the fork is the forker's own private
 * thread in the same project, copied up to the shared leaf. Unsharing makes it private again.
 *
 * Reaching a run: `run.start.project` ({@link runProjectContextSchema}) carries the instructions
 * of the thread's project; kobe-sandbox-agent appends them to the system prompt of every turn of
 * the run (after the memory index). Project files are not sent: they are synced read-only into the
 * members' sandboxes at {@link projectMountPath} (workspace area `projects`, origin `server`).
 *
 * Agent writes: `commit_project` (project-commits.ts); `propose_project_file` was removed in WS-7.
 */

/** `hello.capabilities` entry of an agent that registers `commit_project`. */
export const CAPABILITY_PROJECTS = "projects";

export const PROJECT_NAME_MAX = 100;
/** Instructions are added to every thread's context, so they are bounded (UTF-8 bytes). */
export const PROJECT_INSTRUCTIONS_MAX_BYTES = 8 * 1024;
export const PROJECT_DESCRIPTION_MAX = 500;
export const PROJECT_SLUG_MAX = 40;
export const PROJECT_MEMBERS_MAX = 500;
export const PROJECT_FILE_MAX_BYTES = 50 * 1024 * 1024;
/** Most files one project holds; the server answers `quota_exceeded` beyond. */
export const PROJECT_FILES_MAX = 500;

/** Lowercase, digits, hyphens; first char alphanumeric. Unique per team; used as the mount folder. */
export const projectSlugSchema = z
  .string()
  .max(PROJECT_SLUG_MAX)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "invalid project slug");

export const PROJECT_WORKSPACE_DIR = "projects";
/** Where a member's sandbox sees the project's files (read-only). */
export const projectMountPath = (slug: string): string =>
  `/workspace/${PROJECT_WORKSPACE_DIR}/${slug}`;

const storageCountSchema = z.number().int().nonnegative();
const nameSchema = z.string().trim().min(1).max(PROJECT_NAME_MAX);
const descriptionSchema = z.string().max(PROJECT_DESCRIPTION_MAX);
const instructionsSchema = z
  .string()
  .refine((s) => utf8ByteLength(s) <= PROJECT_INSTRUCTIONS_MAX_BYTES, {
    message: `instructions exceed ${PROJECT_INSTRUCTIONS_MAX_BYTES} bytes`,
  });

// ----------------------------------------------------------------------------- roles

export const PROJECT_ROLES = ["owner", "editor", "reader"] as const;
export const projectRoleSchema = z.enum(PROJECT_ROLES);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

/** Who sees a project beyond its explicit rows (PR2). Default on create: `workspace`. */
export const PROJECT_VISIBILITIES = ["workspace", "restricted"] as const;
export const projectVisibilitySchema = z.enum(PROJECT_VISIBILITIES);
export type ProjectVisibility = z.infer<typeof projectVisibilitySchema>;

export const PROJECT_ACTIONS = [
  "create", // needs team role contributor or team admin
  "view", // browse files, read history, read shared threads and memory
  "converse", // start threads, share own threads, fork shared ones (readers too)
  "edit", // check out, edit, commit, update, discard, upload and remove files, revert
  "manage", // edit name/instructions/agent, archive/delete
  "manage_members", // visibility, members, roles, ownership
] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

/** Effective project role (PR3): the explicit row, else `reader` when visibility is `workspace`. */
export function effectiveProjectRole(
  projectRole: ProjectRole | undefined,
  visibility: ProjectVisibility,
): ProjectRole | undefined {
  return projectRole ?? (visibility === "workspace" ? "reader" : undefined);
}

/**
 * Who may do what (PR3 matrix). `projectRole` is the caller's explicit row (`undefined` = none).
 * Team admins act as owners of every project without being listed. Creating needs team role
 * contributor or team admin and is independent of the project (pass any visibility).
 */
export function projectPermissions(
  teamRole: z.infer<typeof teamRoleSchema>,
  projectRole: ProjectRole | undefined,
  visibility: ProjectVisibility,
): Record<ProjectAction, boolean> {
  const admin = teamRole === "team_admin";
  const role = effectiveProjectRole(projectRole, visibility);
  const owner = admin || role === "owner";
  const editor = owner || role === "editor";
  const reader = editor || role === "reader";
  return {
    create: admin || teamRole === "contributor",
    view: reader,
    converse: reader,
    edit: editor,
    manage: owner,
    manage_members: owner,
  };
}

/**
 * Add to project (KOBE-585): may the caller copy an artifact version or a scratchspace file into a
 * project? Editors, owners and team admins (the earlier "builders who are members" reading became
 * "editor+" with the Workspaces roles; readers never write). Equals {@link projectPermissions}
 * `edit`, kept as a named rule for the import route.
 */
export function canAddToProject(
  teamRole: z.infer<typeof teamRoleSchema>,
  projectRole: ProjectRole | undefined,
  visibility: ProjectVisibility,
): boolean {
  return projectPermissions(teamRole, projectRole, visibility).edit;
}

// ----------------------------------------------------------------------------- REST: projects

export const projectSchema = z.strictObject({
  id: uuidSchema,
  team_id: uuidSchema,
  slug: projectSlugSchema,
  name: nameSchema,
  description: descriptionSchema,
  instructions: instructionsSchema,
  /** Default agent for new threads in the project; null = the team default. */
  default_agent_id: uuidSchema.nullable(),
  /** `workspace` = every member is a reader; `restricted` = only {@link projectMemberSchema} rows. */
  visibility: projectVisibilitySchema,
  /** The caller's effective role; null = team admin who is not listed. */
  my_role: projectRoleSchema.nullable(),
  file_count: z.number().int().nonnegative(),
  /** The latest commit (commit shapes: project-commits.ts); null = no commit yet. */
  head_commit_id: uuidSchema.nullable(),
  /** Storage (GV2): null until the server fills them (WS-4). History = blobs only old commits hold. */
  live_bytes: storageCountSchema.nullable(),
  history_bytes: storageCountSchema.nullable(),
  live_objects: storageCountSchema.nullable(),
  history_objects: storageCountSchema.nullable(),
  created_by: uuidSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  archived_at: timestampSchema.nullable(),
});
export type Project = z.infer<typeof projectSchema>;

/**
 * `POST /v1/projects` -> 201 {@link projectSchema}. The creator becomes `owner`. `slug` absent =
 * derived from the name. `visibility` absent = `workspace`. `member_user_ids` only with
 * `visibility: "restricted"` (creator implied) and become editors.
 */
export const createProjectRequestSchema = z
  .strictObject({
    name: nameSchema,
    slug: projectSlugSchema.optional(),
    description: descriptionSchema.optional(),
    instructions: instructionsSchema.optional(),
    default_agent_id: uuidSchema.nullable().optional(),
    visibility: projectVisibilitySchema.optional(),
    member_user_ids: z.array(uuidSchema).max(PROJECT_MEMBERS_MAX).optional(),
  })
  .refine((v) => v.member_user_ids === undefined || v.visibility === "restricted", {
    message: "member_user_ids needs visibility restricted",
    path: ["member_user_ids"],
  });
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/** `PATCH /v1/projects/:id` -> {@link projectSchema}; absent key = unchanged; owners and admins. */
export const updateProjectRequestSchema = z
  .strictObject({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    instructions: instructionsSchema.optional(),
    default_agent_id: uuidSchema.nullable().optional(),
    visibility: projectVisibilitySchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "empty update" });
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

/** `GET /v1/projects?include_archived=` -> list of projects the caller can view. */
export const projectListResponseSchema = z.strictObject({ projects: z.array(projectSchema) });
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
/** `DELETE /v1/projects/:id` -> 204 (owners, admins; threads stay, unshared and project-less). */

// ----------------------------------------------------------------------------- REST: members

export const projectMemberSchema = z.strictObject({
  user_id: uuidSchema,
  role: projectRoleSchema,
  added_at: timestampSchema,
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;

/** `GET /v1/projects/:id/members` -> list (all explicit rows). */
export const projectMembersResponseSchema = z.strictObject({
  visibility: projectVisibilitySchema,
  members: z.array(projectMemberSchema).max(PROJECT_MEMBERS_MAX),
});
export type ProjectMembersResponse = z.infer<typeof projectMembersResponseSchema>;

/** `POST /v1/projects/:id/members` (user must be in the team) -> 201 {@link projectMemberSchema}. */
export const addProjectMemberRequestSchema = z.strictObject({
  user_id: uuidSchema,
  role: projectRoleSchema.optional(),
});
export type AddProjectMemberRequest = z.infer<typeof addProjectMemberRequestSchema>;

/** `PATCH /v1/projects/:id/members/:user_id`; `DELETE` same path -> 204. The last owner stays (`last_owner`). */
export const updateProjectMemberRequestSchema = z.strictObject({ role: projectRoleSchema });
export type UpdateProjectMemberRequest = z.infer<typeof updateProjectMemberRequestSchema>;

// ----------------------------------------------------------------------------- REST: files

export const projectFileSchema = z.strictObject({
  id: uuidSchema,
  project_id: uuidSchema,
  /** Path inside the project folder (no `projects/<slug>/` prefix), `/`-separated. */
  path: workspacePathSchema,
  size_bytes: z.number().int().nonnegative(),
  sha256: sha256HexSchema,
  mime_type: z.string().min(1).max(255),
  /** `upload` = a person added it; `proposal` = an agent proposed it and an approval granted it. */
  source: z.enum(["upload", "proposal"]),
  added_by: uuidSchema,
  added_at: timestampSchema,
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

/** `GET /v1/projects/:id/files` -> list (members). */
export const projectFilesResponseSchema = z.strictObject({
  files: z.array(projectFileSchema).max(PROJECT_FILES_MAX),
});
export type ProjectFilesResponse = z.infer<typeof projectFilesResponseSchema>;

/**
 * `POST /v1/projects/:id/files` (multipart/form-data, owners and admins): text field `path`
 * (folder, absent = root) then one file part named per `uploadFileNameSchema`, at most
 * {@link PROJECT_FILE_MAX_BYTES}. 201 {@link projectFileSchema}. Same name+folder = `already_exists`.
 * `DELETE /v1/projects/:id/files/:file_id` -> 204 (owners, admins). Files reach sandboxes on the
 * next workspace sync, read-only.
 */
export const projectFileUploadFieldsSchema = z.strictObject({
  path: z.union([z.literal(""), workspacePathSchema]).optional(),
});
export const projectFileNameSchema = uploadFileNameSchema;

/** What Add to project copies: an artifact version the caller reads, or their own synced file. */
export const projectFileImportSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("artifact"),
    artifact_id: uuidSchema,
    version: z.number().int().positive(),
  }),
  z.strictObject({ kind: z.literal("workspace_file"), path: workspacePathSchema }),
]);
export type ProjectFileImportSource = z.infer<typeof projectFileImportSourceSchema>;

/**
 * `POST /v1/projects/:id/files/import` (KOBE-585) -> 201 {@link projectFileSchema}. The server
 * copies the bytes it stored (never the browser's) under the upload's quotas and name rules;
 * `folder` absent = root, `name` absent = the artifact's `<slug>.<ext>` or the file's name. Rights:
 * {@link canAddToProject}. A same-name file answers 409 `already_exists` (no replace in place).
 */
export const importProjectFileRequestSchema = z.strictObject({
  source: projectFileImportSourceSchema,
  folder: z.union([z.literal(""), workspacePathSchema]).optional(),
  name: projectFileNameSchema.optional(),
});
export type ImportProjectFileRequest = z.infer<typeof importProjectFileRequestSchema>;

// ----------------------------------------------------------------------------- REST: share and fork

/**
 * A thread's share scope (D23, CE20): `private` (its owner only), `project` (members of its project,
 * read-only) or `team` (every member of the team, read-only; KOBE-221). Team admins have no wider
 * view: they read a member's thread only when it is shared to them like to anyone else.
 */
export const THREAD_VISIBILITIES = ["private", "project", "team"] as const;
export const threadVisibilitySchema = z.enum(THREAD_VISIBILITIES);
export type ThreadVisibility = z.infer<typeof threadVisibilitySchema>;

/**
 * Optional on thread summaries (absent = `private`, no project): the thread's project and
 * visibility. `read_only` is computed for the caller: true for a shared thread of someone else.
 */
export const threadProjectFieldsSchema = z.strictObject({
  project_id: uuidSchema.nullable().optional(),
  visibility: threadVisibilitySchema.optional(),
  read_only: z.boolean().optional(),
});
export type ThreadProjectFields = z.infer<typeof threadProjectFieldsSchema>;

/**
 * `POST /v1/threads/:id/share` (author only) -> 200 {@link threadProjectFieldsSchema}. `project`
 * needs the thread to be in a project; `team` does not; `private` revokes either share at once,
 * including open event streams of readers.
 */
export const shareThreadRequestSchema = z.strictObject({ visibility: threadVisibilitySchema });
export type ShareThreadRequest = z.infer<typeof shareThreadRequestSchema>;

/**
 * `POST /v1/threads/:id/fork` (any project member, on a shared thread, or the author on any own
 * thread) -> 201 `{ thread_id }`: a new private thread of the caller in the same project, copied up
 * to `entry_id` (absent = the leaf). Shared files are not copied.
 */
export const forkThreadRequestSchema = z.strictObject({
  entry_id: idSchema.optional(),
  /** Same rules as create and rename: no control characters (a NUL would be a 500). */
  title: threadTitleSchema.optional(),
});
export type ForkThreadRequest = z.infer<typeof forkThreadRequestSchema>;
export const forkThreadResponseSchema = z.strictObject({ thread_id: uuidSchema });
export type ForkThreadResponse = z.infer<typeof forkThreadResponseSchema>;

/** Thread `POST` (create) takes an optional `project_id` (member of it); absent = no project. */
export const createThreadProjectFieldSchema = z.strictObject({ project_id: uuidSchema.optional() });

// ----------------------------------------------------------------------------- errors

/** REST error `code` values of the project API (HTTP status in brackets, informative). */
export const PROJECT_ERROR_CODES = [
  "not_found", // 404 (also for projects the caller may not view)
  "forbidden", // 403
  "slug_taken", // 409
  "already_exists", // 409 (file or member)
  "last_owner", // 409
  "not_in_team", // 422 member user not in the team
  "not_in_project", // 422 thread has no project
  "not_shared", // 403 fork/read of a private thread
  "read_only", // 403 write to a shared thread of someone else
  "archived", // 409
  "file_too_large", // 413
  "quota_exceeded", // 413 (with `limit`: see projectQuotaErrorSchema)
  "invalid_input", // 422
  "project_in_use", // 409 delete refused: threads, project memory or files remain
  ...PROJECT_COMMIT_ERROR_CODES,
] as const;
export const projectErrorCodeSchema = z.enum(PROJECT_ERROR_CODES);
export type ProjectErrorCode = z.infer<typeof projectErrorCodeSchema>;

// ----------------------------------------------------------------------------- run.start context

/**
 * `run.start.project`: absent = thread has no project, or an old server. Sent only to agents whose
 * hello lists {@link CAPABILITY_PROJECTS}. Small by design: id, slug, name, instructions (at most
 * {@link PROJECT_INSTRUCTIONS_MAX_BYTES} bytes, never truncated silently: `truncated` says so).
 * `mount` is {@link projectMountPath}; the agent tells the model where the files are.
 */
export const runProjectContextSchema = z.strictObject({
  id: uuidSchema,
  slug: projectSlugSchema,
  name: nameSchema,
  instructions: instructionsSchema,
  truncated: z.boolean().optional(),
  mount: z.string().min(1).max(100),
  /**
   * The viewer's access (CM6): `write` = editor or above, the agent may register `commit_project`;
   * `read` = reader. Absent = an old server (treated as `read` by a new agent).
   */
  access: z.enum(["read", "write"]).optional(),
});
export type RunProjectContext = z.infer<typeof runProjectContextSchema>;

// ----------------------------------------------------------------------------- project tools

/**
 * WS-7 (KOBE-582): `propose_project_file` and its frames (`project.file_propose`,
 * `project.file_propose_result`) were removed; an agent saves project files with `commit_project`
 * (project-commits.ts) from its own checkout. `project_files.source` keeps `proposal` as a
 * historical value.
 */
export const PROJECT_TOOLS = ["commit_project"] as const;
export const projectToolInputSchema = {
  commit_project: commitProjectToolInputSchema,
} as const;
