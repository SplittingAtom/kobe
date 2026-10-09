import { describe, expect, it } from "vitest";
import {
  CAPABILITY_PROJECTS,
  PROJECT_INSTRUCTIONS_MAX_BYTES,
  SANDBOX_WIRE_VERSION,
  addProjectMemberRequestSchema,
  createProjectRequestSchema,
  decodeSandboxFrame,
  decodeServerFrame,
  forkThreadRequestSchema,
  kobeToolsRequestSchema,
  kobeToolsResponseSchema,
  projectFileSchema,
  projectMountPath,
  projectPermissions,
  projectSchema,
  projectSlugSchema,
  proposeProjectFileInputSchema,
  runProjectContextSchema,
  runStartFrameSchema,
  shareThreadRequestSchema,
  threadProjectFieldsSchema,
  updateProjectRequestSchema,
} from "./index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const TS = "2026-10-09T10:00:00Z";
const SHA = "a".repeat(64);
const v = SANDBOX_WIRE_VERSION;

describe("roles", () => {
  it("builders create, owners manage, admins manage all, members use", () => {
    expect(projectPermissions("builder", undefined).create).toBe(true);
    expect(projectPermissions("member", undefined).create).toBe(false);
    expect(projectPermissions("builder", "owner").manage_members).toBe(true);
    expect(projectPermissions("builder", "member").manage).toBe(false);
    expect(projectPermissions("builder", "member").use).toBe(true);
    expect(projectPermissions("builder", undefined).view).toBe(false);
    const admin = projectPermissions("team_admin", undefined);
    expect(admin.manage && admin.manage_members && admin.view).toBe(true);
  });
});

describe("project API", () => {
  const project = {
    id: ID,
    team_id: ID2,
    slug: "q4-launch",
    name: "Q4 launch",
    description: "",
    instructions: "Be terse.",
    default_agent_id: null,
    members_mode: "team",
    my_role: null,
    file_count: 0,
    created_by: ID2,
    created_at: TS,
    updated_at: TS,
    archived_at: null,
  };
  it("decodes a project", () => {
    expect(projectSchema.safeParse(project).success).toBe(true);
  });
  it("slugs", () => {
    expect(projectSlugSchema.safeParse("a-b1").success).toBe(true);
    for (const bad of ["", "-a", "A", "a/b", "..", "a".repeat(41)])
      expect(projectSlugSchema.safeParse(bad).success).toBe(false);
  });
  it("create: minimal, selected members, bounded instructions", () => {
    expect(createProjectRequestSchema.safeParse({ name: "P" }).success).toBe(true);
    expect(
      createProjectRequestSchema.safeParse({
        name: "P",
        members_mode: "selected",
        member_user_ids: [ID],
      }).success,
    ).toBe(true);
    expect(createProjectRequestSchema.safeParse({ name: "P", member_user_ids: [ID] }).success).toBe(
      false,
    );
    expect(
      createProjectRequestSchema.safeParse({
        name: "P",
        instructions: "x".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(createProjectRequestSchema.safeParse({ name: " " }).success).toBe(false);
  });
  it("update: partial, not empty", () => {
    expect(updateProjectRequestSchema.safeParse({ default_agent_id: null }).success).toBe(true);
    expect(updateProjectRequestSchema.safeParse({}).success).toBe(false);
  });
  it("members", () => {
    expect(addProjectMemberRequestSchema.safeParse({ user_id: ID }).success).toBe(true);
    expect(addProjectMemberRequestSchema.safeParse({ user_id: ID, role: "boss" }).success).toBe(
      false,
    );
  });
  it("project file", () => {
    const f = {
      id: ID,
      project_id: ID2,
      path: "docs/a.md",
      size_bytes: 3,
      sha256: SHA,
      mime_type: "text/markdown",
      source: "proposal",
      added_by: ID2,
      added_at: TS,
    };
    expect(projectFileSchema.safeParse(f).success).toBe(true);
    expect(projectFileSchema.safeParse({ ...f, path: "../a" }).success).toBe(false);
  });
});

describe("share and fork", () => {
  it("share, fork, thread fields (old thread shapes need none)", () => {
    expect(shareThreadRequestSchema.safeParse({ visibility: "project" }).success).toBe(true);
    expect(shareThreadRequestSchema.safeParse({ visibility: "public" }).success).toBe(false);
    expect(forkThreadRequestSchema.safeParse({}).success).toBe(true);
    expect(forkThreadRequestSchema.safeParse({ entry_id: "abc12345", title: "x" }).success).toBe(
      true,
    );
    expect(threadProjectFieldsSchema.safeParse({}).success).toBe(true);
    expect(
      threadProjectFieldsSchema.safeParse({
        project_id: ID,
        visibility: "project",
        read_only: true,
      }).success,
    ).toBe(true);
  });
});

describe("run.start project context", () => {
  const base = { v, type: "run.start", command_id: "c", run_id: ID, thread_id: ID2, message: "hi" };
  const project = {
    id: ID,
    slug: "q4",
    name: "Q4",
    instructions: "Always cite sources.",
    mount: projectMountPath("q4"),
  };
  it("old run.start without project still decodes", () => {
    expect(runStartFrameSchema.safeParse(base).success).toBe(true);
  });
  it("carries instructions, bounded", () => {
    expect(project.mount).toBe("/workspace/projects/q4");
    expect(runProjectContextSchema.safeParse(project).success).toBe(true);
    expect(runStartFrameSchema.safeParse({ ...base, project }).success).toBe(true);
    const big = { ...project, instructions: "x".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES + 1) };
    expect(runStartFrameSchema.safeParse({ ...base, project: big }).success).toBe(false);
  });
});

describe("propose_project_file", () => {
  const input = { path: "/workspace/out/report.md", folder: "reports", reason: "keep" };
  it("input", () => {
    expect(CAPABILITY_PROJECTS).toBe("projects");
    expect(proposeProjectFileInputSchema.safeParse(input).success).toBe(true);
    expect(proposeProjectFileInputSchema.safeParse({ path: "../x" }).success).toBe(false);
    expect(proposeProjectFileInputSchema.safeParse({ ...input, project_id: ID }).success).toBe(
      false,
    );
  });
  it("kobe-tools op and response", () => {
    const req = {
      id: "r",
      op: "project.file_propose",
      tool_call_id: "t",
      tool: "propose_project_file",
      input,
    };
    expect(kobeToolsRequestSchema.safeParse(req).success).toBe(true);
    const ok = {
      id: "r",
      ok: true,
      op: "project_file_propose",
      status: "pending_approval",
      proposal_id: ID,
      project_id: ID2,
      path: "reports/report.md",
    };
    expect(kobeToolsResponseSchema.safeParse(ok).success).toBe(true);
    expect(
      kobeToolsResponseSchema.safeParse({
        id: "r",
        ok: false,
        error: { code: "not_in_project", message: "m" },
      }).success,
    ).toBe(true);
  });
  it("frames", () => {
    const frame = {
      v,
      type: "project.file_propose",
      request_id: "q",
      run_id: ID,
      thread_id: ID2,
      tool_call_id: "t",
      tool: "propose_project_file",
      input,
      workspace: { path: "out/report.md", rev: 2, sha256: SHA, size: 5 },
    };
    expect(decodeSandboxFrame(JSON.stringify(frame)).ok).toBe(true);
    expect(decodeSandboxFrame(JSON.stringify({ ...frame, workspace: undefined })).ok).toBe(false);
    const result = {
      v,
      type: "project.file_propose_result",
      request_id: "q",
      ok: true,
      op: "project_file_propose",
      status: "pending_approval",
      proposal_id: ID,
      project_id: ID2,
      path: "reports/report.md",
    };
    expect(decodeServerFrame(JSON.stringify(result)).ok).toBe(true);
    const fail = {
      v,
      type: "project.file_propose_result",
      request_id: "q",
      ok: false,
      error: { code: "future", message: "m" },
    };
    expect(decodeServerFrame(JSON.stringify(fail)).ok).toBe(true);
  });
});
