import { describe, expect, it } from "vitest";
import {
  ARTIFACT_CONTENT_MAX_BYTES,
  ARTIFACT_KINDS,
  KOBE_TOOLS_FD,
  SANDBOX_FRAME_MAX_BYTES_BY_TYPE,
  artifactDetailSchema,
  artifactSummarySchema,
  artifactToolInputSchema,
  createArtifactInputSchema,
  decodeSandboxFrame,
  decodeServerFrame,
  encodeFrame,
  kobeToolsRequestSchema,
  kobeToolsResponseSchema,
  updateArtifactInputSchema,
  CAPABILITY_ARTIFACTS,
} from "./index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const create = { kind: "html", title: "Chart", content: "<p>x</p>" };

describe("create_artifact input", () => {
  it("accepts every kind", () => {
    expect([...ARTIFACT_KINDS]).toEqual(["html", "svg", "markdown", "mermaid", "code", "csv"]);
    for (const kind of ARTIFACT_KINDS)
      expect(createArtifactInputSchema.safeParse({ ...create, kind }).success).toBe(true);
  });
  it("caps content at 512 KiB UTF-8 bytes", () => {
    expect(ARTIFACT_CONTENT_MAX_BYTES).toBe(512 * 1024);
    const ok = "a".repeat(ARTIFACT_CONTENT_MAX_BYTES);
    expect(createArtifactInputSchema.safeParse({ ...create, content: ok }).success).toBe(true);
    expect(createArtifactInputSchema.safeParse({ ...create, content: ok + "a" }).success).toBe(
      false,
    );
    // multi-byte: 3 bytes per char, fewer chars than the cap but more bytes
    const wide = "€".repeat(ARTIFACT_CONTENT_MAX_BYTES / 3 + 1);
    expect(createArtifactInputSchema.safeParse({ ...create, content: wide }).success).toBe(false);
  });
  it.each([
    ["unknown kind", { ...create, kind: "tsx" }],
    ["empty title", { ...create, title: "" }],
    ["long title", { ...create, title: "t".repeat(201) }],
    ["extra key", { ...create, x: 1 }],
    ["language on non-code", { ...create, language: "python" }],
    ["bad language", { ...create, kind: "code", language: "Py thon" }],
    ["long language", { ...create, kind: "code", language: "a".repeat(33) }],
    ["missing content", { kind: "html", title: "t" }],
  ])("rejects %s", (_n, input) => {
    expect(createArtifactInputSchema.safeParse(input).success).toBe(false);
  });
  it("accepts language for code", () => {
    for (const language of ["python", "c++", "c#", "objective-c", "f#"])
      expect(
        createArtifactInputSchema.safeParse({ ...create, kind: "code", language }).success,
      ).toBe(true);
  });
});

describe("update_artifact input", () => {
  it("accepts content with optional title", () => {
    expect(updateArtifactInputSchema.safeParse({ artifact_id: ID, content: "x" }).success).toBe(
      true,
    );
    expect(
      updateArtifactInputSchema.safeParse({ artifact_id: ID, content: "x", title: "T" }).success,
    ).toBe(true);
  });
  it.each([
    ["non-uuid id", { artifact_id: "a1", content: "x" }],
    ["empty title", { artifact_id: ID, content: "x", title: "" }],
    ["oversize", { artifact_id: ID, content: "a".repeat(ARTIFACT_CONTENT_MAX_BYTES + 1) }],
    ["kind", { artifact_id: ID, content: "x", kind: "html" }],
  ])("rejects %s", (_n, input) => {
    expect(updateArtifactInputSchema.safeParse(input).success).toBe(false);
  });
  it("picks the schema by tool", () => {
    expect(artifactToolInputSchema.create_artifact).toBe(createArtifactInputSchema);
    expect(artifactToolInputSchema.update_artifact).toBe(updateArtifactInputSchema);
  });
});

describe("artifact.put / artifact.result frames", () => {
  const put = {
    v: 1,
    type: "artifact.put",
    request_id: "ar_1",
    run_id: EXAMPLE_IDS.run,
    thread_id: EXAMPLE_IDS.thread,
    tool_call_id: "tc_1",
    tool: "create_artifact",
    input: create,
  };
  it("has capability name and a 1 MiB cap entry", () => {
    expect(CAPABILITY_ARTIFACTS).toBe("artifacts");
    expect(SANDBOX_FRAME_MAX_BYTES_BY_TYPE["artifact.put"]).toBe(1024 * 1024);
  });
  it("round-trips put for both tools", () => {
    expect(decodeSandboxFrame(encodeFrame(put as never)).ok).toBe(true);
    const upd = { ...put, tool: "update_artifact", input: { artifact_id: ID, content: "y" } };
    expect(decodeSandboxFrame(JSON.stringify(upd)).ok).toBe(true);
  });
  it("rejects put whose input does not match its tool", () => {
    const bad = { ...put, tool: "update_artifact" };
    expect(decodeSandboxFrame(JSON.stringify(bad)).ok).toBe(false);
    expect(
      decodeSandboxFrame(
        JSON.stringify({ ...put, input: { ...create, content: "a".repeat(600_000) } }),
      ).ok,
    ).toBe(false);
  });
  it("decodes results, with open error codes", () => {
    const base = { v: 1, type: "artifact.result", request_id: "ar_1" };
    expect(
      decodeServerFrame(JSON.stringify({ ...base, ok: true, artifact_id: ID, version: 2 })).ok,
    ).toBe(true);
    for (const code of ["not_allowed", "storage_failed", "some_future_code"])
      expect(
        decodeServerFrame(JSON.stringify({ ...base, ok: false, error: { code, message: "m" } })).ok,
      ).toBe(true);
    expect(
      decodeServerFrame(
        JSON.stringify({ ...base, ok: false, error: { code: "Bad Code", message: "m" } }),
      ).ok,
    ).toBe(false);
    expect(
      decodeServerFrame(JSON.stringify({ ...base, ok: true, artifact_id: ID, version: 0 })).ok,
    ).toBe(false);
  });
  it("artifact.put is sandbox-only, result is server-only", () => {
    expect(decodeServerFrame(JSON.stringify(put)).ok).toBe(false);
    expect(
      decodeSandboxFrame(
        JSON.stringify({
          v: 1,
          type: "artifact.result",
          request_id: "r",
          ok: true,
          artifact_id: ID,
          version: 1,
        }),
      ).ok,
    ).toBe(false);
  });
});

describe("kobe-tools channel", () => {
  it("uses fd 4", () => expect(KOBE_TOOLS_FD).toBe(4));
  const req = {
    id: "k1",
    op: "artifact.put",
    tool_call_id: "tc_1",
    tool: "create_artifact",
    input: create,
  };
  it("accepts requests and responses", () => {
    expect(kobeToolsRequestSchema.safeParse(req).success).toBe(true);
    expect(
      kobeToolsRequestSchema.safeParse({
        ...req,
        tool: "update_artifact",
        input: { artifact_id: ID, content: "x" },
      }).success,
    ).toBe(true);
    expect(
      kobeToolsResponseSchema.safeParse({ id: "k1", ok: true, artifact_id: ID, version: 1 })
        .success,
    ).toBe(true);
    expect(
      kobeToolsResponseSchema.safeParse({
        id: "k1",
        ok: false,
        error: { code: "too_large", message: "m" },
      }).success,
    ).toBe(true);
  });
  it.each([
    ["unknown op", { ...req, op: "share_file" }],
    ["mismatched input", { ...req, tool: "update_artifact" }],
    ["extra key", { ...req, x: 1 }],
  ])("rejects request: %s", (_n, r) => {
    expect(kobeToolsRequestSchema.safeParse(r).success).toBe(false);
  });
  it("rejects a response with both ok shapes mixed", () => {
    expect(
      kobeToolsResponseSchema.safeParse({ id: "k1", ok: true, error: { code: "x", message: "m" } })
        .success,
    ).toBe(false);
  });
});

describe("API types", () => {
  const summary = {
    id: ID,
    thread_id: EXAMPLE_IDS.thread,
    kind: "code",
    title: "T",
    language: "python",
    current_version: 2,
    created_at: "2026-10-05T10:00:00.000Z",
    updated_at: "2026-10-05T10:00:00.000Z",
  };
  it("parses summary and detail", () => {
    expect(artifactSummarySchema.safeParse(summary).success).toBe(true);
    expect(artifactSummarySchema.safeParse({ ...summary, language: null }).success).toBe(true);
    const detail = {
      ...summary,
      versions: [{ version: 1, size_bytes: 10, created_at: summary.created_at }],
    };
    expect(artifactDetailSchema.safeParse(detail).success).toBe(true);
    expect(artifactDetailSchema.safeParse(summary).success).toBe(false);
  });
});

describe("kobe-tools memory ops (KOBE-157)", () => {
  it("accepts memory.put / memory.read requests and their answers, nothing else", () => {
    const put = {
      id: "kt_1",
      op: "memory.put",
      tool_call_id: "c1",
      input: { scope: "user", path: "a.md", content: "x" },
    };
    expect(kobeToolsRequestSchema.safeParse(put).success).toBe(true);
    expect(kobeToolsRequestSchema.safeParse({ ...put, tool: "remember" }).success).toBe(false);
    expect(
      kobeToolsRequestSchema.safeParse({
        id: "kt_2",
        op: "memory.read",
        tool_call_id: "c2",
        input: {},
      }).success,
    ).toBe(true);
    expect(
      kobeToolsResponseSchema.safeParse({
        id: "kt_1",
        ok: true,
        op: "put",
        status: "applied",
        scope: "user",
        path: "a.md",
        version: 1,
      }).success,
    ).toBe(true);
    expect(
      kobeToolsResponseSchema.safeParse({
        id: "kt_2",
        ok: true,
        op: "read",
        files: [],
        truncated: false,
      }).success,
    ).toBe(true);
  });
});
