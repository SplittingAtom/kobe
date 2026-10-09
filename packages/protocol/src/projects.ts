import { z } from "zod";
import type { teamRoleSchema } from "./common.js";
import { idSchema, timestampSchema, utf8ByteLength, uuidSchema } from "./common.js";
import { sha256HexSchema, workspacePathSchema } from "./sandbox-wire/workspace-sync.js";
import { uploadFileNameSchema } from "./uploads.js";

/**
 * Projects contract (KOBE-159 = 57a of KOBE-57, spec D23; notes in docs/ledger/KOBE-159.md).
 * Additive: an agent without {@link CAPABILITY_PROJECTS} never registers `propose_project_file`;
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
 * Agent-proposed file: `propose_project_file` -> kobe-policy `policy.check` (project write, so a
 * signed approval is required as for project memory) -> kobe-tools `project.file_propose` on fd 4
 * -> frame `project.file_propose`. Push-then-propose, as `share_file` (files.ts): the agent first
 * pushes the file through workspace sync and sends the pushed entry as `workspace`. The server
 * checks the thread is in a project and the entry is unchanged, stores a pending proposal and
 * answers `status: "pending_approval"`; when the approval is granted the blob is copied into the
 * project's files and `project.file_added` is not an event (the file shows up in the project API).
 */

/** `hello.capabilities` entry of an agent that registers `propose_project_file`. */
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

const nameSchema = z.string().trim().min(1).max(PROJECT_NAME_MAX);
const descriptionSchema = z.string().max(PROJECT_DESCRIPTION_MAX);
const instructionsSchema = z
  .string()
  .refine((s) => utf8ByteLength(s) <= PROJECT_INSTRUCTIONS_MAX_BYTES, {
    message: `instructions exceed ${PROJECT_INSTRUCTIONS_MAX_BYTES} bytes`,
  });

// ----------------------------------------------------------------------------- roles

export const PROJECT_ROLES = ["owner", "member"] as const;
export const projectRoleSchema = z.enum(PROJECT_ROLES);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

export const PROJECT_ACTIONS = [
  "create",
  "view",
  "use", // start threads, share own threads, fork shared ones
  "manage", // edit name/instructions/agent, manage files, archive/delete
  "manage_members",
] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

/**
 * Who may do what. `projectRole` is the caller's membership (`undefined` = not a member). With
 * `members_mode: "team"` every team member is an implicit `member`; the server resolves that
 * before calling this. Team admins manage all projects of their team; creating needs `builder`
 * (or admin); using needs membership.
 */
export function projectPermissions(
  teamRole: z.infer<typeof teamRoleSchema>,
  projectRole: ProjectRole | undefined,
): Record<ProjectAction, boolean> {
  const admin = teamRole === "team_admin";
  const owner = projectRole === "owner";
  const member = projectRole !== undefined;
  return {
    create: admin || teamRole === "builder",
    view: admin || member,
    use: admin || member,
    manage: admin || owner,
    manage_members: admin || owner,
  };
}

// ----------------------------------------------------------------------------- REST: projects

export const PROJECT_MEMBERS_MODES = ["team", "selected"] as const;
export const projectMembersModeSchema = z.enum(PROJECT_MEMBERS_MODES);
export type ProjectMembersMode = z.infer<typeof projectMembersModeSchema>;

export const projectSchema = z.strictObject({
  id: uuidSchema,
  team_id: uuidSchema,
  slug: projectSlugSchema,
  name: nameSchema,
  description: descriptionSchema,
  instructions: instructionsSchema,
  /** Default agent for new threads in the project; null = the team default. */
  default_agent_id: uuidSchema.nullable(),
  /** `team` = every team member is a member; `selected` = only {@link projectMemberSchema} rows. */
  members_mode: projectMembersModeSchema,
  /** The caller's effective role; null = team admin who is not a member. */
  my_role: projectRoleSchema.nullable(),
  file_count: z.number().int().nonnegative(),
  created_by: uuidSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  archived_at: timestampSchema.nullable(),
});
export type Project = z.infer<typeof projectSchema>;

/**
 * `POST /v1/projects` -> 201 {@link projectSchema}. The creator becomes `owner`. `slug` absent =
 * derived from the name. `member_user_ids` only with `members_mode: "selected"` (creator implied).
 */
export const createProjectRequestSchema = z
  .strictObject({
    name: nameSchema,
    slug: projectSlugSchema.optional(),
    description: descriptionSchema.optional(),
    instructions: instructionsSchema.optional(),
    default_agent_id: uuidSchema.nullable().optional(),
    members_mode: projectMembersModeSchema.optional(),
    member_user_ids: z.array(uuidSchema).max(PROJECT_MEMBERS_MAX).optional(),
  })
  .refine((v) => v.member_user_ids === undefined || v.members_mode === "selected", {
    message: "member_user_ids needs members_mode selected",
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
    members_mode: projectMembersModeSchema.optional(),
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

/** `GET /v1/projects/:id/members` -> list (explicit rows; with mode `team` the owners only). */
export const projectMembersResponseSchema = z.strictObject({
  members_mode: projectMembersModeSchema,
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

// ----------------------------------------------------------------------------- REST: share and fork

export const THREAD_VISIBILITIES = ["private", "project"] as const;
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

/** `POST /v1/threads/:id/share` (author only; the thread must already be in a project) -> 200 {@link threadProjectFieldsSchema}. */
export const shareThreadRequestSchema = z.strictObject({ visibility: threadVisibilitySchema });
export type ShareThreadRequest = z.infer<typeof shareThreadRequestSchema>;

/**
 * `POST /v1/threads/:id/fork` (any project member, on a shared thread, or the author on any own
 * thread) -> 201 `{ thread_id }`: a new private thread of the caller in the same project, copied up
 * to `entry_id` (absent = the leaf). Shared files are not copied.
 */
export const forkThreadRequestSchema = z.strictObject({
  entry_id: idSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
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
  "quota_exceeded", // 413
  "invalid_input", // 422
  "project_in_use", // 409 delete refused: threads, project memory or files remain
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
});
export type RunProjectContext = z.infer<typeof runProjectContextSchema>;

// ----------------------------------------------------------------------------- propose_project_file

export const PROJECT_TOOLS = ["propose_project_file"] as const;
export const PROJECT_PROPOSE_REASON_MAX = 500;

/**
 * Model-facing input. `path` is a workspace path (absolute `/workspace/...` or relative); the
 * project is the thread's own (never chosen by the model). `name` = file name in the project,
 * default the file's name; `folder` = target folder in the project, default root.
 */
export const proposeProjectFileInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(1024)
    // eslint-disable-next-line no-control-regex
    .refine((p) => !/[\u0000-\u001f\u007f]/u.test(p), "control character in path")
    .refine((p) => !p.split("/").includes(".."), "path traversal"),
  name: uploadFileNameSchema.optional(),
  folder: z.union([z.literal(""), workspacePathSchema]).optional(),
  /** Shown on the approval card. */
  reason: z.string().min(1).max(PROJECT_PROPOSE_REASON_MAX).optional(),
});
export type ProposeProjectFileInput = z.infer<typeof proposeProjectFileInputSchema>;
export const projectToolInputSchema = {
  propose_project_file: proposeProjectFileInputSchema,
} as const;

/** The pushed workspace entry (same evidence as `share_file`; the server needs it unchanged). */
export const proposeProjectFileWorkspaceRefSchema = z.strictObject({
  path: workspacePathSchema,
  rev: z.number().int().positive(),
  sha256: sha256HexSchema,
  size: z.number().int().nonnegative(),
});

/** Open on the sandbox side; known: {@link PROJECT_PROPOSE_ERROR_CODES}. */
export const PROJECT_PROPOSE_ERROR_CODES = [
  "not_allowed",
  "not_in_project",
  "not_synced",
  "not_found",
  "invalid_input",
  "too_large",
  "quota_exceeded",
  "already_exists",
  "storage_failed",
] as const;
export const projectProposeErrorSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().max(2000),
});

/**
 * Success answer (shared by frame and kobe-tools response, flat). `pending_approval` = the proposal
 * is stored and waits for the signed approval; `applied` = approved and added (e.g. auto-approved
 * by policy). `file` is present once applied.
 */
export const projectProposeOkFields = {
  ok: z.literal(true),
  op: z.literal("project_file_propose"),
  status: z.enum(["pending_approval", "applied"]),
  proposal_id: uuidSchema,
  project_id: uuidSchema,
  path: workspacePathSchema,
  file: projectFileSchema.optional(),
} as const;
export const projectProposeFailFields = {
  ok: z.literal(false),
  error: projectProposeErrorSchema,
} as const;

/** kobe-tools request (fd 4); member of the tools request union via `projectToolsRequestSchema`. */
export const projectToolsRequestSchema = z.strictObject({
  id: idSchema,
  op: z.literal("project.file_propose"),
  tool_call_id: idSchema,
  tool: z.literal("propose_project_file"),
  input: proposeProjectFileInputSchema,
});
export type ProjectToolsRequest = z.infer<typeof projectToolsRequestSchema>;

export const projectToolsResponseSchema = z.union([
  z.strictObject({ id: idSchema, ...projectProposeOkFields }),
  z.strictObject({ id: idSchema, ...projectProposeFailFields }),
]);
export type ProjectToolsResponse = z.infer<typeof projectToolsResponseSchema>;
