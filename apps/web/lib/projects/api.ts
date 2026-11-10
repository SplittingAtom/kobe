/**
 * Projects over the shared API client (`/v1/projects`, KOBE-161/162; share and fork on
 * `/v1/threads`, KOBE-163). Responses arrive camelized; request bodies use the routes' snake_case.
 * Every call sends `X-Kobe-Team`. The server decides who may do what: the UI only hides controls.
 */
import { apiDownload, apiRequest, type ApiResult } from "../api/client";
import type { ThreadPage } from "../chat/types";

/** Project roles (PR3): owners manage, editors change files and commit, readers read and converse. */
export type ProjectRole = "owner" | "editor" | "reader";
/**
 * Roles a listed member holds (RV1, KOBE-587): every workspace member reads every project, so
 * nobody is listed as a reader.
 */
export type ProjectMemberRole = "owner" | "editor";
export const PROJECT_MEMBER_ROLES: readonly ProjectMemberRole[] = ["owner", "editor"];

export interface Project {
  readonly id: string;
  readonly teamId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly defaultAgentId: string | null;
  /** The caller's effective role; null = a team admin who is not listed (acts as owner). */
  readonly myRole: ProjectRole | null;
  readonly fileCount: number;
  /** The latest commit; null = no commit yet (absent on older answers). */
  readonly headCommitId?: string | null | undefined;
  /** Storage (GV2): null until the server fills them. */
  readonly liveBytes?: number | null | undefined;
  readonly historyBytes?: number | null | undefined;
  readonly liveObjects?: number | null | undefined;
  readonly historyObjects?: number | null | undefined;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ProjectMember {
  readonly userId: string;
  readonly role: ProjectMemberRole;
  readonly addedAt: string;
}

export interface ProjectMembers {
  readonly members: readonly ProjectMember[];
}

export interface ProjectFile {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mimeType: string;
  /** `proposal` = an agent proposed it and an approval granted it. */
  readonly source: "upload" | "proposal";
  readonly addedBy: string;
  readonly addedAt: string;
}

/** Add to project (KOBE-585): what the server copies from its own stored bytes. */
export type ImportSource =
  | { readonly kind: "artifact"; readonly artifactId: string; readonly version: number }
  | { readonly kind: "workspace_file"; readonly path: string };

export interface ImportRequest {
  readonly source: ImportSource;
  /** Folder inside the project; "" = root. */
  readonly folder: string;
  readonly name: string;
}

export interface ProjectInput {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly defaultAgentId: string | null;
}

export interface ProjectAgent {
  readonly id: string;
  readonly name: string;
  readonly scope: "team" | "personal" | "gallery";
}

/** `POST /v1/projects/:id/owner` (PR5): who owns it now, and who handed it over (null: an admin assigned). */
export interface OwnerTransfer {
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly previousOwnerUserId: string | null;
}

export interface ProjectsApi {
  list(includeArchived: boolean): Promise<ApiResult<readonly Project[]>>;
  /** Team admins: projects without an owner row (PR5, "No owner: assign one"). */
  noOwner(): Promise<ApiResult<readonly Project[]>>;
  transferOwner(id: string, userId: string): Promise<ApiResult<OwnerTransfer>>;
  /** The project's latest files as a zip (`GET /v1/projects/:id/download`, GV5; readers too). */
  downloadHead(id: string): Promise<ApiResult<Uint8Array>>;
  get(id: string): Promise<ApiResult<Project>>;
  create(input: ProjectInput): Promise<ApiResult<Project>>;
  update(
    id: string,
    input: Partial<ProjectInput> & { archived?: boolean },
  ): Promise<ApiResult<Project>>;
  remove(id: string): Promise<ApiResult<void>>;
  members(id: string): Promise<ApiResult<ProjectMembers>>;
  addMember(id: string, userId: string, role: ProjectMemberRole): Promise<ApiResult<ProjectMember>>;
  setMemberRole(
    id: string,
    userId: string,
    role: ProjectMemberRole,
  ): Promise<ApiResult<ProjectMember>>;
  removeMember(id: string, userId: string): Promise<ApiResult<void>>;
  files(id: string): Promise<ApiResult<readonly ProjectFile[]>>;
  uploadFile(id: string, file: File, folder: string): Promise<ApiResult<ProjectFile>>;
  removeFile(id: string, fileId: string): Promise<ApiResult<void>>;
  /** Add to project (KOBE-585): 409 `already_exists` on a same-name file. */
  importFile(id: string, request: ImportRequest): Promise<ApiResult<ProjectFile>>;
  /** Agents a project may default to: the server accepts team and gallery agents only. */
  agents(): Promise<ApiResult<readonly ProjectAgent[]>>;
  /** The project's conversations: the caller's own and those shared to the project. */
  threads(id: string): Promise<ApiResult<ThreadPage>>;
}

const enc = encodeURIComponent;

function mapData<W, T>(res: ApiResult<W>, fn: (w: W) => T): ApiResult<T> {
  return res.ok ? { ...res, data: fn(res.data) } : res;
}

function toBody(input: Partial<ProjectInput> & { archived?: boolean }): Record<string, unknown> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.defaultAgentId === undefined ? {} : { default_agent_id: input.defaultAgentId }),
    ...(input.archived === undefined ? {} : { archived: input.archived }),
  };
}

export function createProjectsApi(teamId: string, fetchFn?: typeof fetch): ProjectsApi {
  const call = <T>(
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
    json?: unknown,
  ) => apiRequest<T>(path, { method, json, teamId, fetchFn });
  const base = (id: string) => `/v1/projects/${enc(id)}`;
  return {
    list: async (includeArchived) =>
      mapData(
        await call<{ projects: Project[] }>(
          `/v1/projects${includeArchived ? "?include_archived=true" : ""}`,
        ),
        (r) => r.projects,
      ),
    noOwner: async () =>
      mapData(await call<{ projects: Project[] }>("/v1/projects/no-owner"), (r) => r.projects),
    downloadHead: (id) => apiDownload(`${base(id)}/download`, { teamId, fetchFn }),
    transferOwner: (id, userId) => call(`${base(id)}/owner`, "POST", { user_id: userId }),
    get: (id) => call<Project>(base(id)),
    create: (input) => call<Project>("/v1/projects", "POST", toBody(input)),
    update: (id, input) => call<Project>(base(id), "PATCH", toBody(input)),
    remove: (id) => call(base(id), "DELETE"),
    members: (id) => call<ProjectMembers>(`${base(id)}/members`),
    addMember: (id, userId, role) =>
      call<ProjectMember>(`${base(id)}/members`, "POST", { user_id: userId, role }),
    setMemberRole: (id, userId, role) =>
      call<ProjectMember>(`${base(id)}/members/${enc(userId)}`, "PATCH", { role }),
    removeMember: (id, userId) => call(`${base(id)}/members/${enc(userId)}`, "DELETE"),
    files: async (id) => {
      const res = await call<{ files: ProjectFile[] }>(`${base(id)}/files`);
      return res.ok ? { ...res, data: res.data.files } : res;
    },
    uploadFile: (id, file, folder) => {
      const form = new FormData();
      form.append("path", folder); // the folder field comes before the file part
      form.append("file", file, file.name);
      return apiRequest(`${base(id)}/files`, { method: "POST", form, teamId, fetchFn });
    },
    removeFile: (id, fileId) => call(`${base(id)}/files/${enc(fileId)}`, "DELETE"),
    importFile: (id, { source, folder, name }) =>
      call(`${base(id)}/files/import`, "POST", {
        source:
          source.kind === "artifact"
            ? { kind: "artifact", artifact_id: source.artifactId, version: source.version }
            : { kind: "workspace_file", path: source.path },
        ...(folder === "" ? {} : { folder }),
        name,
      }),
    agents: async () => {
      const res = await call<{ agents: ProjectAgent[] }>("/v1/agents/runnable?limit=200");
      return res.ok ? { ...res, data: res.data.agents.filter((a) => a.scope !== "personal") } : res;
    },
    threads: (id) => call(`/v1/threads?project_id=${enc(id)}`),
  };
}

/** The words for a failed project call (the server's own messages, except where better exist). */
export function describeProjectError(error: {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}): string {
  if (error.code === "slug_taken") return "Another project already uses that web name.";
  if (error.code === "last_owner") {
    return "A project keeps at least one owner: make someone else an owner first.";
  }
  if (error.code === "not_in_team") return "That person is not in this workspace.";
  if (error.code === "read_only") return "You can read this project, not change it.";
  if (error.code === "checkout_required") return "Check out the project to change its files.";
  if (error.code === "too_many_mounts") return error.message;
  if (error.code === "already_exists") return "That is already there.";
  if (error.code === "archived") return "This project is archived, so it cannot change.";
  if (error.code === "file_too_large") return "That file is too large (50 MiB at most).";
  return error.message;
}

/** The same result with the error worded for people (see {@link describeProjectError}). */
export function worded<T>(res: ApiResult<T>): ApiResult<T> {
  return res.ok
    ? res
    : { ok: false, error: { ...res.error, message: describeProjectError(res.error) } };
}
