import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FILES,
  EVENT_PAYLOAD_SCHEMAS,
  FILE_SHARE_DESCRIPTION_MAX,
  FILE_SHARE_ERROR_CODES,
  FILE_SHARE_MAX_BYTES,
  KOBE_TOOLS_FD,
  SANDBOX_FRAME_MAX_BYTES_BY_TYPE,
  SANDBOX_SMALL_FRAME_MAX_BYTES,
  UPLOAD_DEFAULT_MAX_FILE_BYTES,
  canonicalJson,
  decodeSandboxFrame,
  decodeServerFrame,
  kobeToolsRequestSchema,
  kobeToolsResponseSchema,
  shareFileInputSchema,
  toolInputSchema,
  workspaceDeleteQuerySchema,
  workspaceDownloadQuerySchema,
  workspaceFileEntrySchema,
  WORKSPACE_FILE_ERROR_CODES,
  WORKSPACE_LIST_CURSOR_MAX,
  workspaceFileErrorSchema,
  workspaceListQuerySchema,
  workspaceListResponseSchema,
  workspaceUploadFieldsSchema,
} from "./index.js";
import { EVENT_PAYLOAD_EXAMPLES, EXAMPLE_IDS } from "./testing/index.js";

const SHA = "a".repeat(64);
const entry = {
  name: "report.docx",
  path: "reports/report.docx",
  type: "file",
  size_bytes: 48_213,
  mtime: "2026-10-09T10:00:00Z",
  source: "synced",
  owner: "sandbox",
  area: "workspace",
};

describe("workspace file browser", () => {
  it("decodes list entries (file and dir)", () => {
    expect(workspaceFileEntrySchema.parse(entry)).toEqual(entry);
    const dir = { ...entry, name: "reports", path: "reports", type: "dir", size_bytes: null };
    expect(workspaceFileEntrySchema.parse(dir)).toEqual(dir);
    const live = { ...entry, source: "live", sha256: SHA, mime_type: "text/plain" };
    expect(workspaceFileEntrySchema.parse(live)).toEqual(live);
  });
  it("rejects bad entries", () => {
    for (const bad of [
      { ...entry, type: "link" },
      { ...entry, source: "cache" },
      { ...entry, area: "etc" },
      { ...entry, type: "dir" }, // dirs have no size
      { ...entry, size_bytes: null }, // files have one
      { ...entry, path: "/abs" },
      { ...entry, extra: 1 },
    ])
      expect(workspaceFileEntrySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it("list response and queries", () => {
    expect(workspaceListResponseSchema.parse({ path: "", entries: [entry] })).toBeTruthy();
    expect(workspaceListQuerySchema.safeParse({}).success).toBe(true); // root
    expect(workspaceListQuerySchema.safeParse({ path: "a/b" }).success).toBe(true);
    expect(workspaceListQuerySchema.safeParse({ path: "../x" }).success).toBe(false);
    expect(workspaceDownloadQuerySchema.safeParse({}).success).toBe(false); // path required
    expect(workspaceDownloadQuerySchema.safeParse({ path: "a.txt" }).success).toBe(true);
    expect(workspaceDeleteQuerySchema.safeParse({ path: "" }).success).toBe(false);
  });
  it("paging cursor and legal_hold are additive (KOBE-184)", () => {
    // Old shapes still decode: no cursor, no next_cursor.
    expect(workspaceListQuerySchema.safeParse({ path: "a" }).success).toBe(true);
    expect(workspaceListResponseSchema.safeParse({ path: "", entries: [] }).success).toBe(true);
    expect(workspaceListQuerySchema.safeParse({ cursor: "eyJkIjoxfQ" }).success).toBe(true);
    for (const bad of ["", "a b", "a/b", "x".repeat(WORKSPACE_LIST_CURSOR_MAX + 1)])
      expect(workspaceListQuerySchema.safeParse({ cursor: bad }).success, bad).toBe(false);
    const page = { path: "", entries: [entry], next_cursor: "abc_-9" };
    expect(workspaceListResponseSchema.safeParse(page).success).toBe(true);
    expect(workspaceListResponseSchema.safeParse({ ...page, next_cursor: "" }).success).toBe(false);
    expect(
      workspaceFileErrorSchema.safeParse({ code: "legal_hold", message: "held" }).success,
    ).toBe(true);
    expect(WORKSPACE_FILE_ERROR_CODES).toContain("read_only"); // kept
  });
  it("upload fields: folder path ('' = root), strict", () => {
    expect(workspaceUploadFieldsSchema.safeParse({}).success).toBe(true);
    expect(workspaceUploadFieldsSchema.safeParse({ path: "data/in" }).success).toBe(true);
    expect(workspaceUploadFieldsSchema.safeParse({ path: "/etc" }).success).toBe(false);
    expect(workspaceUploadFieldsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
  it("error body has a closed code", () => {
    expect(workspaceFileErrorSchema.safeParse({ code: "read_only", message: "m" }).success).toBe(
      true,
    );
    expect(workspaceFileErrorSchema.safeParse({ code: "nope", message: "m" }).success).toBe(false);
  });
});

describe("share_file input", () => {
  const ok = { path: "/workspace/out/report.docx" };
  it("accepts path with optional name and description", () => {
    expect(shareFileInputSchema.safeParse(ok).success).toBe(true);
    expect(shareFileInputSchema.safeParse({ path: "out/a.csv" }).success).toBe(true);
    expect(
      shareFileInputSchema.safeParse({ ...ok, name: "Q3.docx", description: "Quarterly" }).success,
    ).toBe(true);
  });
  it("is strict and rejects traversal, bad names and long descriptions", () => {
    for (const bad of [
      {},
      { path: "" },
      { path: "../x" },
      { path: "/workspace/../etc/passwd" },
      { path: "a\u0000b" },
      { ...ok, name: "a/b" },
      { ...ok, description: "x".repeat(FILE_SHARE_DESCRIPTION_MAX + 1) },
      { ...ok, extra: 1 },
    ])
      expect(shareFileInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it("is canonicalJson-safe", () => {
    const input = { path: "out/a.csv", name: "é.csv", description: "d" };
    expect(toolInputSchema.safeParse(input).success).toBe(true);
    expect(JSON.parse(canonicalJson(input))).toEqual(input);
  });
});

describe("kobe-tools file.share", () => {
  const request = {
    id: "r1",
    op: "file.share",
    tool_call_id: "tc_1",
    tool: "share_file",
    input: { path: "out/a.csv" },
  };
  it("decodes the request and keeps artifact.put working", () => {
    expect(KOBE_TOOLS_FD).toBe(4);
    expect(kobeToolsRequestSchema.safeParse(request).success).toBe(true);
    expect(kobeToolsRequestSchema.safeParse({ ...request, tool: "create_artifact" }).success).toBe(
      false,
    );
    expect(kobeToolsRequestSchema.safeParse({ ...request, input: {} }).success).toBe(false);
    expect(
      kobeToolsRequestSchema.safeParse({
        id: "r2",
        op: "artifact.put",
        tool_call_id: "tc_2",
        tool: "create_artifact",
        input: { kind: "html", title: "T", content: "x" },
      }).success,
    ).toBe(true);
  });
  const ok = {
    id: "r1",
    ok: true,
    file_id: EXAMPLE_IDS.file,
    name: "a.csv",
    mime_type: "text/csv",
    size_bytes: 3,
    scan: "skipped",
    created_at: "2026-10-09T10:00:00Z",
    sha256: SHA,
  };
  it("decodes ok and error responses; artifact responses still decode", () => {
    expect(kobeToolsResponseSchema.safeParse(ok).success).toBe(true);
    expect(
      kobeToolsResponseSchema.safeParse({
        id: "r1",
        ok: false,
        error: { code: "not_synced", message: "m" },
      }).success,
    ).toBe(true);
    expect(
      kobeToolsResponseSchema.safeParse({
        id: "r1",
        ok: true,
        artifact_id: EXAMPLE_IDS.artifact,
        version: 1,
      }).success,
    ).toBe(true);
    expect(kobeToolsResponseSchema.safeParse({ ...ok, size_bytes: -1 }).success).toBe(false);
  });
});

describe("sandbox wire frames", () => {
  const share = {
    v: 1,
    type: "file.share",
    request_id: "req1",
    run_id: EXAMPLE_IDS.run,
    thread_id: EXAMPLE_IDS.thread,
    tool_call_id: "tc_1",
    tool: "share_file",
    input: { path: "/workspace/out/a.csv", name: "a.csv" },
    workspace: { path: "out/a.csv", rev: 7, sha256: SHA, size: 3 },
  };
  it("announces capability files", () => {
    expect(CAPABILITY_FILES).toBe("files");
  });
  it("decodes file.share and rejects a mismatching shape", () => {
    expect(decodeSandboxFrame(JSON.stringify(share))).toMatchObject({ ok: true });
    for (const bad of [
      { ...share, tool: "create_artifact" },
      { ...share, workspace: undefined },
      { ...share, workspace: { ...share.workspace, sha256: "XYZ" } },
      { ...share, workspace: { ...share.workspace, path: "/abs" } },
      { ...share, workspace: { ...share.workspace, rev: 0 } },
      { ...share, input: { path: "../x" } },
    ])
      expect(decodeSandboxFrame(JSON.stringify(bad)).ok, JSON.stringify(bad)).toBe(false);
  });
  it("decodes file.share_result ok and error (open error code)", () => {
    const okResult = {
      v: 1,
      type: "file.share_result",
      request_id: "req1",
      ok: true,
      file_id: EXAMPLE_IDS.file,
      name: "a.csv",
      mime_type: "text/csv",
      size_bytes: 3,
      scan: "clean",
      created_at: "2026-10-09T10:00:00Z",
      sha256: SHA,
    };
    expect(decodeServerFrame(JSON.stringify(okResult))).toMatchObject({ ok: true });
    for (const code of [...FILE_SHARE_ERROR_CODES, "a_code_from_the_future"])
      expect(
        decodeServerFrame(
          JSON.stringify({
            v: 1,
            type: "file.share_result",
            request_id: "req1",
            ok: false,
            error: { code, message: "m" },
          }),
        ),
      ).toMatchObject({ ok: true });
  });
  it("states sizes: file.share is a small frame, shared files are capped like uploads", () => {
    expect(SANDBOX_FRAME_MAX_BYTES_BY_TYPE).not.toHaveProperty("file.share");
    expect(JSON.stringify(share).length).toBeLessThan(SANDBOX_SMALL_FRAME_MAX_BYTES);
    expect(FILE_SHARE_MAX_BYTES).toBe(UPLOAD_DEFAULT_MAX_FILE_BYTES);
  });
});

describe("file.shared event", () => {
  const schema = EVENT_PAYLOAD_SCHEMAS["file.shared"];
  it("old payloads still decode; description is additive", () => {
    expect(schema.safeParse(EVENT_PAYLOAD_EXAMPLES["file.shared"]).success).toBe(true);
    const withDesc = { ...EVENT_PAYLOAD_EXAMPLES["file.shared"], description: "Quarterly" };
    expect(schema.safeParse(withDesc).success).toBe(true);
    expect(schema.safeParse({ ...withDesc, description: "" }).success).toBe(false);
    expect(schema.safeParse({ ...withDesc, other: 1 }).success).toBe(false);
  });
});
