/**
 * Projects over the shared API client (`/v1/projects`, KOBE-161/162; share and fork on
 * `/v1/threads`, KOBE-163). Responses arrive camelized; request bodies use the routes' snake_case.
 * Every call sends `X-Kobe-Team`. The server decides who may do what: the UI only hides controls.
 */
import { apiRequest, type ApiResult } from "../api/client";
import type { ThreadPage } from "../chat/types";

export type ProjectRole = "owner" | "member";
export type MembersMode = "team" | "selected";

export interface Project {
  readonly id: string;
  readonly teamId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly defaultAgentId: string | null;
  readonly membersMode: MembersMode;
  /** The caller's effective role; null = a team admin who is not a member. */
  readonly myRole: ProjectRole | null;
  readonly fileCount: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ProjectMember {
  readonly userId: string;
  readonly role: ProjectRole;
  readonly addedAt: string;
}

export interface ProjectMembers {
  readonly membersMode: MembersMode;
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

export interface ProjectInput {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly defaultAgentId: string | null;
  readonly membersMode: MembersMode;
}

export interface ProjectAgent {
  readonly id: string;
  readonly name: string;
  readonly scope: "team" | "personal" | "gallery";
}

export interface ProjectsApi {
  list(includeArchived: boolean): Promise<ApiResult<readonly Project[]>>;
  get(id: string): Promise<ApiResult<Project>>;
  create(input: ProjectInput): Promise<ApiResult<Project>>;
  update(
    id: string,
    input: Partial<ProjectInput> & { archived?: boolean },
  ): Promise<ApiResult<Project>>;
  remove(id: string): Promise<ApiResult<void>>;
  members(id: string): Promise<ApiResult<ProjectMembers>>;
  addMember(id: string, userId: string, role: ProjectRole): Promise<ApiResult<ProjectMember>>;
  setMemberRole(id: string, userId: string, role: ProjectRole): Promise<ApiResult<ProjectMember>>;
  removeMember(id: string, userId: string): Promise<ApiResult<void>>;
  files(id: string): Promise<ApiResult<readonly ProjectFile[]>>;
  uploadFile(id: string, file: File, folder: string): Promise<ApiResult<ProjectFile>>;
  removeFile(id: string, fileId: string): Promise<ApiResult<void>>;
  /** Agents a project may default to: the server accepts team and gallery agents only. */
  agents(): Promise<ApiResult<readonly ProjectAgent[]>>;
  /** The project's conversations: the caller's own and those shared to the project. */
  threads(id: string): Promise<ApiResult<ThreadPage>>;
}

const enc = encodeURIComponent;

function toBody(input: Partial<ProjectInput> & { archived?: boolean }): Record<string, unknown> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.defaultAgentId === undefined ? {} : { default_agent_id: input.defaultAgentId }),
    ...(input.membersMode === undefined ? {} : { members_mode: input.membersMode }),
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
    list: async (includeArchived) => {
      const res = await call<{ projects: Project[] }>(
        `/v1/projects${includeArchived ? "?include_archived=true" : ""}`,
      );
      return res.ok ? { ...res, data: res.data.projects } : res;
    },
    get: (id) => call(base(id)),
    create: (input) =>
      call("/v1/projects", "POST", {
        ...toBody(input),
        ...(input.membersMode === "team" ? {} : { member_user_ids: [] }),
      }),
    update: (id, input) => call(base(id), "PATCH", toBody(input)),
    remove: (id) => call(base(id), "DELETE"),
    members: (id) => call(`${base(id)}/members`),
    addMember: (id, userId, role) => call(`${base(id)}/members`, "POST", { user_id: userId, role }),
    setMemberRole: (id, userId, role) =>
      call(`${base(id)}/members/${enc(userId)}`, "PATCH", { role }),
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
  if (error.code === "last_owner") return "A project keeps at least one owner.";
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
