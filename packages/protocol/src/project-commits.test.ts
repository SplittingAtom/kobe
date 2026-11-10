import { describe, expect, it } from "vitest";
import {
  PROJECT_AUDIT_EVENTS,
  PROJECT_COMMIT_MESSAGE_MAX,
  PROJECT_ERROR_CODES,
  PROJECT_HISTORY_MAX_COMMITS,
  PROJECT_MOUNTS_MAX_PER_MEMBER,
  SANDBOX_WIRE_VERSION,
  TEAM_ROLES,
  checkoutProjectRequestSchema,
  commitConflictErrorSchema,
  commitProjectRequestSchema,
  commitProjectResponseSchema,
  commitProjectToolInputSchema,
  decodeSandboxFrame,
  decodeServerFrame,
  kobeToolsRequestSchema,
  kobeToolsResponseSchema,
  projectCheckoutSchema,
  projectCommitDetailSchema,
  projectCommitSchema,
  projectHistoryQuerySchema,
  projectHistoryResponseSchema,
  projectQuotaErrorSchema,
  projectToolInputSchema,
  projectTreeEntrySchema,
  revertProjectRequestSchema,
  runProjectContextSchema,
  runStartFrameSchema,
  teamRoleSchema,
  BUILTIN_TOOLS,
  tooManyMountsErrorSchema,
  listProjectsQuerySchema,
  transferOwnerRequestSchema,
  transferOwnerResponseSchema,
  updateCheckoutResponseSchema,
  workspaceManifestPageSchema,
} from "./index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const TS = "2026-11-08T10:00:00Z";
const SHA = "b".repeat(64);
const v = SANDBOX_WIRE_VERSION;

const commit = {
  id: ID,
  project_id: ID2,
  seq: 1,
  parent_id: null,
  author_user_id: ID2,
  author_kind: "user",
  thread_id: null,
  run_id: null,
  message: "first",
  file_count: 1,
  bytes: 3,
  created_at: TS,
};
const entry = {
  path: "docs/a.md",
  sha256: SHA,
  blob_ref: "teams/t/projects/p/blobs/" + SHA,
  size_bytes: 3,
  mime_type: "text/markdown",
  executable: false,
};

describe("team roles", () => {
  it("emits contributor, never builder", () => {
    expect(TEAM_ROLES).toEqual(["team_admin", "contributor", "member"]);
    expect(teamRoleSchema.safeParse("contributor").success).toBe(true);
    expect(teamRoleSchema.safeParse("builder").success).toBe(false);
  });
  it("never accepts builder (MG0)", () => {
    expect(teamRoleSchema.safeParse("builder").success).toBe(false);
  });
});

describe("constants", () => {
  it("defaults", () => {
    expect(PROJECT_HISTORY_MAX_COMMITS).toBe(1000);
    expect(PROJECT_MOUNTS_MAX_PER_MEMBER).toBe(20);
    expect(PROJECT_COMMIT_MESSAGE_MAX).toBe(500);
    expect(PROJECT_AUDIT_EVENTS).toHaveLength(6);
    expect(new Set(PROJECT_AUDIT_EVENTS).size).toBe(6);
  });
  it("error codes are unique and include the commit codes", () => {
    expect(new Set(PROJECT_ERROR_CODES).size).toBe(PROJECT_ERROR_CODES.length);
    for (const c of [
      "commit_conflict",
      "nothing_to_commit",
      "too_many_mounts",
      "checkout_required",
      "quota_exceeded",
      "read_only",
    ])
      expect(PROJECT_ERROR_CODES).toContain(c);
  });
});

describe("commit records", () => {
  it("decodes a commit, with and without optional links", () => {
    expect(projectCommitSchema.safeParse(commit).success).toBe(true);
    expect(
      projectCommitSchema.safeParse({
        ...commit,
        seq: 2,
        parent_id: ID,
        author_kind: "agent",
        thread_id: ID,
        run_id: ID2,
      }).success,
    ).toBe(true);
  });
  it("refuses bad commits", () => {
    const bad = [
      { ...commit, seq: 0 },
      { ...commit, message: "" },
      { ...commit, message: "x".repeat(PROJECT_COMMIT_MESSAGE_MAX + 1) },
      { ...commit, author_kind: "bot" },
      { ...commit, extra: 1 },
      { ...commit, bytes: -1 },
    ];
    for (const c of bad) expect(projectCommitSchema.safeParse(c).success).toBe(false);
    const { thread_id: _t, ...missing } = commit;
    expect(projectCommitSchema.safeParse(missing).success).toBe(false);
  });
  it("tree entries", () => {
    expect(projectTreeEntrySchema.safeParse(entry).success).toBe(true);
    for (const bad of [
      { ...entry, path: "../x" },
      { ...entry, sha256: "XYZ" },
      { ...entry, executable: undefined },
      { ...entry, blob_ref: "" },
      { ...entry, mode: 0o644 },
    ])
      expect(projectTreeEntrySchema.safeParse(bad).success).toBe(false);
  });
  it("checkouts", () => {
    const co = {
      project_id: ID,
      slug: "q4",
      base_commit_id: ID2,
      base_commit_seq: 3,
      created_at: TS,
      updated_at: TS,
    };
    expect(projectCheckoutSchema.safeParse(co).success).toBe(true);
    expect(
      projectCheckoutSchema.safeParse({ ...co, base_commit_id: null, base_commit_seq: null })
        .success,
    ).toBe(true);
    expect(projectCheckoutSchema.safeParse({ ...co, slug: "Bad Slug" }).success).toBe(false);
    expect(projectCheckoutSchema.safeParse({ ...co, user_id: ID }).success).toBe(false);
  });
});

describe("checkout, commit, update, revert", () => {
  it("checkout takes an empty body", () => {
    expect(checkoutProjectRequestSchema.safeParse({}).success).toBe(true);
    expect(checkoutProjectRequestSchema.safeParse({ force: true }).success).toBe(false);
  });
  it("commit request", () => {
    expect(commitProjectRequestSchema.safeParse({ message: "Fix typo" }).success).toBe(true);
    for (const bad of [
      {},
      { message: "  " },
      { message: "x".repeat(501) },
      { message: "m", amend: true },
    ])
      expect(commitProjectRequestSchema.safeParse(bad).success).toBe(false);
  });
  it("commit responses", () => {
    expect(
      commitProjectResponseSchema.safeParse({ status: "committed", seq: 2, commit_id: ID }).success,
    ).toBe(true);
    expect(commitProjectResponseSchema.safeParse({ status: "nothing_to_commit" }).success).toBe(
      true,
    );
    expect(commitProjectResponseSchema.safeParse({ status: "committed", seq: 2 }).success).toBe(
      false,
    );
    expect(
      commitProjectResponseSchema.safeParse({ status: "nothing_to_commit", seq: 1 }).success,
    ).toBe(false);
  });
  it("conflict, quota and mount errors", () => {
    expect(
      commitConflictErrorSchema.safeParse({ code: "commit_conflict", message: "m", head_seq: 4 })
        .success,
    ).toBe(true);
    expect(
      commitConflictErrorSchema.safeParse({ code: "commit_conflict", message: "m" }).success,
    ).toBe(false);
    for (const limit of ["bytes", "objects"])
      expect(
        projectQuotaErrorSchema.safeParse({ code: "quota_exceeded", message: "m", limit }).success,
      ).toBe(true);
    expect(
      projectQuotaErrorSchema.safeParse({ code: "quota_exceeded", message: "m" }).success,
    ).toBe(false);
    expect(
      projectQuotaErrorSchema.safeParse({ code: "quota_exceeded", message: "m", limit: "files" })
        .success,
    ).toBe(false);
    expect(
      tooManyMountsErrorSchema.safeParse({ code: "too_many_mounts", message: "m", limit: 20 })
        .success,
    ).toBe(true);
    expect(
      tooManyMountsErrorSchema.safeParse({ code: "too_many_mounts", message: "m", limit: 0 })
        .success,
    ).toBe(false);
  });
  it("update lists conflict paths", () => {
    expect(
      updateCheckoutResponseSchema.safeParse({ base_commit_seq: 5, conflict_paths: [] }).success,
    ).toBe(true);
    expect(
      updateCheckoutResponseSchema.safeParse({
        base_commit_seq: 5,
        conflict_paths: ["a.conflict-1.md"],
      }).success,
    ).toBe(true);
    expect(updateCheckoutResponseSchema.safeParse({ base_commit_seq: 5 }).success).toBe(false);
    expect(
      updateCheckoutResponseSchema.safeParse({ base_commit_seq: 5, conflict_paths: ["../x"] })
        .success,
    ).toBe(false);
  });
  it("revert message is optional", () => {
    expect(revertProjectRequestSchema.safeParse({}).success).toBe(true);
    expect(revertProjectRequestSchema.safeParse({ message: "undo" }).success).toBe(true);
    expect(revertProjectRequestSchema.safeParse({ message: "" }).success).toBe(false);
    expect(revertProjectRequestSchema.safeParse({ seq: 1 }).success).toBe(false);
  });
});

describe("history and detail", () => {
  it("history query coerces the cursor", () => {
    expect(projectHistoryQuerySchema.parse({})).toEqual({});
    expect(projectHistoryQuerySchema.parse({ before: "12", limit: "10" })).toEqual({
      before: 12,
      limit: 10,
    });
    for (const bad of [
      { before: "0" },
      { before: "x" },
      { limit: "0" },
      { limit: "201" },
      { page: "1" },
    ])
      expect(projectHistoryQuerySchema.safeParse(bad).success).toBe(false);
  });
  it("history page", () => {
    expect(
      projectHistoryResponseSchema.safeParse({ commits: [commit], next_before: null }).success,
    ).toBe(true);
    expect(projectHistoryResponseSchema.safeParse({ commits: [], next_before: 1 }).success).toBe(
      true,
    );
    expect(projectHistoryResponseSchema.safeParse({ commits: [] }).success).toBe(false);
  });
  it("detail with added, modified and deleted", () => {
    const detail = {
      commit,
      tree: [entry],
      diff: [
        { change: "added", path: "a.md", size_bytes: 1 },
        { change: "modified", path: "b.md", size_bytes: 2, previous_size_bytes: 1 },
        { change: "deleted", path: "c.md", previous_size_bytes: 9 },
      ],
    };
    expect(projectCommitDetailSchema.safeParse(detail).success).toBe(true);
    expect(projectCommitDetailSchema.safeParse({ ...detail, diff: [] }).success).toBe(true);
    expect(
      projectCommitDetailSchema.safeParse({
        ...detail,
        diff: [{ change: "renamed", path: "a", size_bytes: 1 }],
      }).success,
    ).toBe(false);
    expect(
      projectCommitDetailSchema.safeParse({ ...detail, diff: [{ change: "added", path: "a" }] })
        .success,
    ).toBe(false);
  });
});

describe("sandbox wire", () => {
  const base = { v, type: "run.start", command_id: "c", run_id: ID, thread_id: ID2, message: "hi" };
  const project = {
    id: ID,
    slug: "q4",
    name: "Q4",
    instructions: "",
    mount: "/workspace/projects/q4",
  };

  it("run.start without project.access still parses (additive)", () => {
    expect(runProjectContextSchema.safeParse(project).success).toBe(true);
    expect(runStartFrameSchema.safeParse({ ...base, project }).success).toBe(true);
    expect(runStartFrameSchema.safeParse(base).success).toBe(true);
  });
  it("carries access read or write, nothing else", () => {
    for (const access of ["read", "write"])
      expect(
        runStartFrameSchema.safeParse({ ...base, project: { ...project, access } }).success,
      ).toBe(true);
    expect(
      runStartFrameSchema.safeParse({ ...base, project: { ...project, access: "admin" } }).success,
    ).toBe(false);
  });
  it("manifest page: checkouts default to none, entries are strict", () => {
    const page = { head_rev: 1, entries: [], more: false };
    expect(workspaceManifestPageSchema.parse(page).checkouts).toEqual([]);
    const ok = { ...page, checkouts: [{ project_id: ID, slug: "q4", base_commit_seq: 2 }] };
    expect(workspaceManifestPageSchema.safeParse(ok).success).toBe(true);
    expect(
      workspaceManifestPageSchema.safeParse({
        ...page,
        checkouts: [{ project_id: ID, slug: "q4" }],
      }).success,
    ).toBe(false);
    expect(
      workspaceManifestPageSchema.safeParse({
        ...page,
        checkouts: [{ project_id: ID, slug: "q4", base_commit_seq: 2, extra: 1 }],
      }).success,
    ).toBe(false);
  });
  it("project.commit frame and result", () => {
    const frame = {
      v,
      type: "project.commit",
      request_id: "q",
      run_id: ID,
      thread_id: ID2,
      tool_call_id: "t",
      tool: "commit_project",
      input: { message: "Add report" },
    };
    expect(decodeSandboxFrame(JSON.stringify(frame)).ok).toBe(true);
    expect(decodeSandboxFrame(JSON.stringify({ ...frame, input: {} })).ok).toBe(false);
    expect(decodeSandboxFrame(JSON.stringify({ ...frame, tool: "propose_project_file" })).ok).toBe(
      false,
    );
    for (const outcome of [
      { status: "committed", seq: 3 },
      { status: "commit_conflict", head_seq: 4 },
      { status: "nothing_to_commit" },
      { status: "pending_approval" },
    ]) {
      const result = {
        v,
        type: "project.commit_result",
        request_id: "q",
        ok: true,
        op: "project_commit",
        outcome,
      };
      expect(decodeServerFrame(JSON.stringify(result)).ok).toBe(true);
    }
    const bad = {
      v,
      type: "project.commit_result",
      request_id: "q",
      ok: true,
      op: "project_commit",
      outcome: { status: "committed" },
    };
    expect(decodeServerFrame(JSON.stringify(bad)).ok).toBe(false);
    const fail = {
      v,
      type: "project.commit_result",
      request_id: "q",
      ok: false,
      error: { code: "read_only", message: "m" },
    };
    expect(decodeServerFrame(JSON.stringify(fail)).ok).toBe(true);
  });
  it("commit_project tool input, registry entry and kobe-tools op", () => {
    expect(commitProjectToolInputSchema.safeParse({ message: "m" }).success).toBe(true);
    expect(commitProjectToolInputSchema.safeParse({ message: "m", project_id: ID }).success).toBe(
      false,
    );
    expect(projectToolInputSchema.commit_project).toBe(commitProjectToolInputSchema);
    expect(BUILTIN_TOOLS.commit_project).toMatchObject({ source: "kobe", risk: "write" });
    const req = {
      id: "r",
      op: "project.commit",
      tool_call_id: "t",
      tool: "commit_project",
      input: { message: "m" },
    };
    expect(kobeToolsRequestSchema.safeParse(req).success).toBe(true);
    expect(kobeToolsRequestSchema.safeParse({ ...req, input: {} }).success).toBe(false);
    const ok = {
      id: "r",
      ok: true,
      op: "project_commit",
      outcome: { status: "nothing_to_commit" },
    };
    expect(kobeToolsResponseSchema.safeParse(ok).success).toBe(true);
  });
});

describe("list query and owner transfer", () => {
  it("list query: role=editor narrows, nothing else", () => {
    expect(listProjectsQuerySchema.parse({})).toEqual({});
    expect(listProjectsQuerySchema.parse({ role: "editor", include_archived: "true" })).toEqual({
      role: "editor",
      include_archived: true,
    });
    for (const bad of [
      { role: "reader" },
      { role: "owner" },
      { include_archived: "yes" },
      { x: 1 },
    ])
      expect(listProjectsQuerySchema.safeParse(bad).success).toBe(false);
  });
  it("owner transfer", () => {
    expect(transferOwnerRequestSchema.safeParse({ user_id: ID }).success).toBe(true);
    expect(transferOwnerRequestSchema.safeParse({}).success).toBe(false);
    expect(transferOwnerRequestSchema.safeParse({ user_id: ID, keep_role: true }).success).toBe(
      false,
    );
    expect(
      transferOwnerResponseSchema.safeParse({
        project_id: ID2,
        owner_user_id: ID,
        previous_owner_user_id: null,
      }).success,
    ).toBe(true);
    expect(
      transferOwnerResponseSchema.safeParse({ project_id: ID2, owner_user_id: ID }).success,
    ).toBe(false);
  });
});
