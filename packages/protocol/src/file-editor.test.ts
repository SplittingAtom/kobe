import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  FILE_EDIT_CONTENT_MAX_BYTES,
  VIEWING_CONTENT_MAX_BYTES,
  fileEditProposeFrameSchema,
  fileEditProposeResultFrameSchema,
  fileEditProposalsResponseSchema,
  fileEditProposedPayloadSchema,
  kobeToolsRequestSchema,
  kobeToolsResponseSchema,
  proposeFileEditInputSchema,
  runStartFrameSchema,
  runViewingContextSchema,
  submitMessageBodySchema,
  workspaceFileErrorSchema,
  workspaceSaveConflictSchema,
  workspaceSaveQuerySchema,
  workspaceToolPath,
} from "./index.js";

const SHA = "b".repeat(64);
const RUN = "3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const THREAD = "4a3b2c1d-6e5f-4a7b-9c8d-1e2f3a4b5c6d";
const input = { path: "/workspace/notes.md", content: "new\n", summary: "Fix the typo" };

describe("propose_file_edit contract (KOBE-462)", () => {
  it("is a built-in read on Kobe's side: not prompted, still policy-checked by path", () => {
    expect(BUILTIN_TOOLS.propose_file_edit).toEqual({
      source: "kobe",
      risk: "read",
      scope: "kobe",
      open_world: false,
      primary_arg: "/path",
    });
  });

  it("takes path, whole content and a summary; nothing else", () => {
    expect(proposeFileEditInputSchema.safeParse(input).success).toBe(true);
    expect(proposeFileEditInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false);
    expect(proposeFileEditInputSchema.safeParse({ ...input, summary: "" }).success).toBe(false);
    expect(proposeFileEditInputSchema.safeParse({ ...input, path: "../etc" }).success).toBe(false);
    expect(proposeFileEditInputSchema.safeParse({ ...input, content: "a\u0000" }).success).toBe(
      false,
    );
  });

  it("caps the content in UTF-8 bytes", () => {
    const at = "é".repeat(FILE_EDIT_CONTENT_MAX_BYTES / 2);
    expect(proposeFileEditInputSchema.safeParse({ ...input, content: at }).success).toBe(true);
    expect(proposeFileEditInputSchema.safeParse({ ...input, content: `${at}x` }).success).toBe(
      false,
    );
  });

  it("normalizes tool paths to workspace paths", () => {
    expect(workspaceToolPath("/workspace/a/b.md")).toBe("a/b.md");
    expect(workspaceToolPath("a/b.md")).toBe("a/b.md");
    expect(workspaceToolPath("/etc/passwd")).toBeUndefined();
    expect(workspaceToolPath("/workspace/")).toBeUndefined();
  });

  it("travels on fd 4 and the wire, and answers awaiting_user", () => {
    expect(
      kobeToolsRequestSchema.safeParse({
        id: "1",
        op: "file.edit_propose",
        tool_call_id: "call_1",
        tool: "propose_file_edit",
        input,
      }).success,
    ).toBe(true);
    const ok = {
      ok: true,
      op: "file_edit_propose",
      status: "awaiting_user",
      path: "notes.md",
      base_sha256: SHA,
    };
    expect(kobeToolsResponseSchema.safeParse({ id: "1", ...ok }).success).toBe(true);
    const frame = {
      v: 1,
      type: "file.edit_propose",
      request_id: "fe_1",
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_1",
      tool: "propose_file_edit",
      input,
    };
    expect(fileEditProposeFrameSchema.safeParse(frame).success).toBe(true);
    expect(
      fileEditProposeResultFrameSchema.safeParse({
        v: 1,
        type: "file.edit_propose_result",
        request_id: "fe_1",
        ...ok,
      }).success,
    ).toBe(true);
    expect(
      fileEditProposeResultFrameSchema.safeParse({
        v: 1,
        type: "file.edit_propose_result",
        request_id: "fe_1",
        ok: false,
        error: { code: "not_found", message: "No synced file there." },
      }).success,
    ).toBe(true);
  });

  it("lists proposals with their run and time", () => {
    expect(
      fileEditProposalsResponseSchema.safeParse({
        proposals: [
          {
            tool_call_id: "call_1",
            run_id: RUN,
            path: "notes.md",
            base_sha256: SHA,
            content: "new\n",
            summary: "Fix the typo",
            created_at: "2026-10-21T10:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("viewed-file context (KOBE-462)", () => {
  it("is an optional workspace path on a message", () => {
    const body = { content: "Tighten this", viewing: { path: "notes.md" } };
    expect(submitMessageBodySchema.safeParse(body).success).toBe(true);
    expect(submitMessageBodySchema.safeParse({ ...body, viewing: { path: "/abs" } }).success).toBe(
      false,
    );
    expect(
      submitMessageBodySchema.safeParse({ ...body, viewing: { path: "a", content: "x" } }).success,
    ).toBe(false);
  });

  it("a regenerate names the prompt entry instead, never both (KOBE-467)", () => {
    const body = { content: "Again", viewing_from_entry: "e1" };
    expect(submitMessageBodySchema.safeParse(body).success).toBe(true);
    expect(submitMessageBodySchema.safeParse({ ...body, viewing: { path: "a.md" } }).success).toBe(
      false,
    );
  });

  it("reaches run.start bounded, content absent for a non-text file", () => {
    const base = { path: "notes.md", sha256: SHA, size: 4, truncated: false };
    expect(runViewingContextSchema.safeParse({ ...base, content: "new\n" }).success).toBe(true);
    expect(runViewingContextSchema.safeParse(base).success).toBe(true);
    expect(
      runViewingContextSchema.safeParse({
        ...base,
        content: "x".repeat(VIEWING_CONTENT_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    const start = {
      v: 1,
      type: "run.start",
      command_id: "c1",
      run_id: RUN,
      thread_id: THREAD,
      message: "hi",
      viewing: { ...base, content: "new\n" },
    };
    expect(runStartFrameSchema.safeParse(start).success).toBe(true);
  });
});

describe("save route (KOBE-462)", () => {
  it("needs the path, and the version the editor loaded for an existing file", () => {
    expect(workspaceSaveQuerySchema.safeParse({ path: "a.md", base_sha256: SHA }).success).toBe(
      true,
    );
    // KOBE-591: no base = create a new file (refused when the path is taken).
    expect(workspaceSaveQuerySchema.safeParse({ path: "a.md" }).success).toBe(true);
    expect(workspaceSaveQuerySchema.safeParse({ base_sha256: SHA }).success).toBe(false);
    expect(
      workspaceSaveQuerySchema.safeParse({ path: "a.md", base_sha256: "B".repeat(64) }).success,
    ).toBe(false);
  });

  it("answers a conflict with the current version, or null when deleted", () => {
    const current = { sha256: SHA, size_bytes: 3, mtime: "2026-10-21T10:00:00.000Z" };
    for (const c of [current, null]) {
      expect(
        workspaceSaveConflictSchema.safeParse({
          code: "version_conflict",
          message: "changed",
          current: c,
        }).success,
      ).toBe(true);
    }
    expect(
      workspaceFileErrorSchema.safeParse({ code: "version_conflict", message: "m" }).success,
    ).toBe(true);
  });
});

describe("proposals for project files and new files (KOBE-591, PE3)", () => {
  const PROJECT = "5b4c3d2e-7f6a-4b8c-9d0e-2f3a4b5c6d7e";
  const PROPOSAL = "6c5d4e3f-8a7b-4c9d-8e1f-3a4b5c6d7e8f";
  const base = {
    tool_call_id: "call_1",
    proposal_id: PROPOSAL,
    path: "projects/budget/plan.md",
    content: "new\n",
    summary: "Adds the plan",
  };

  it("records the project, the head seq and the file's hash at that head", () => {
    expect(
      fileEditProposedPayloadSchema.safeParse({
        ...base,
        base_sha256: SHA,
        project_id: PROJECT,
        base_commit_seq: 3,
      }).success,
    ).toBe(true);
  });

  it("a new file has no base_sha256, in a project or in My files", () => {
    expect(
      fileEditProposedPayloadSchema.safeParse({ ...base, project_id: PROJECT, base_commit_seq: 0 })
        .success,
    ).toBe(true);
    expect(fileEditProposedPayloadSchema.safeParse({ ...base, path: "notes/new.md" }).success).toBe(
      true,
    );
  });

  it("project_id and base_commit_seq come together; old events (no proposal_id) still parse", () => {
    expect(fileEditProposedPayloadSchema.safeParse({ ...base, project_id: PROJECT }).success).toBe(
      false,
    );
    expect(fileEditProposedPayloadSchema.safeParse({ ...base, base_commit_seq: 1 }).success).toBe(
      false,
    );
    expect(
      fileEditProposedPayloadSchema.safeParse({ ...base, project_id: "x", base_commit_seq: 1 })
        .success,
    ).toBe(false);
    expect(
      fileEditProposedPayloadSchema.safeParse({ ...base, extra: true, base_sha256: SHA }).success,
    ).toBe(false);
    const { proposal_id: _drop, ...old } = base;
    expect(fileEditProposedPayloadSchema.safeParse({ ...old, base_sha256: SHA }).success).toBe(
      true,
    );
  });

  it("the listing carries the new fields; the answer may omit base_sha256 (new file)", () => {
    expect(
      fileEditProposalsResponseSchema.safeParse({
        proposals: [
          {
            ...base,
            project_id: PROJECT,
            base_commit_seq: 2,
            run_id: RUN,
            created_at: "2026-11-09T10:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      fileEditProposeResultFrameSchema.safeParse({
        v: 1,
        type: "file.edit_propose_result",
        request_id: "fe_1",
        ok: true,
        op: "file_edit_propose",
        status: "awaiting_user",
        path: "projects/budget/new.md",
      }).success,
    ).toBe(true);
  });
});
