import {
  ARTIFACT_CONTENT_MAX_BYTES,
  ARTIFACT_TITLE_MAX,
  ARTIFACT_TOOLS,
  KOBE_TOOLS_FD,
  KOBE_TOOLS_TIMEOUT_MS,
  CAPABILITY_ARTIFACTS,
  CAPABILITY_FILES,
  FILE_SHARE_DESCRIPTION_MAX,
  FILE_SHARE_PATH_MAX,
  UPLOAD_FILE_NAME_MAX,
  shareFileInputSchema,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { frameSizeProblem } from "./frame-size.js";
import {
  MAX_CONTENT_BYTES,
  MAX_FRAME_BYTES,
  MAX_TITLE_LENGTH,
  OP_ARTIFACT_PUT,
  OP_FILE_SHARE,
  SHARE_DESCRIPTION_MAX,
  SHARE_NAME_MAX,
  SHARE_PATH_MAX,
  TOOL_SHARE_FILE,
  TOOLS_FD,
  TOOLS_TIMEOUT_MS,
  type ToolsRequest,
} from "./protocol.js";
import { artifactTools, shareFileTool, type ToolsTransport } from "./tools.js";
import type { ToolsOutcome } from "./client.js";

function transport(outcome: ToolsOutcome) {
  const calls: Omit<ToolsRequest, "id">[] = [];
  const t: ToolsTransport = {
    request: async (call) => {
      calls.push(call);
      return outcome;
    },
  };
  return { t, calls };
}
const OK: ToolsOutcome = {
  ok: true,
  artifact_id: "11111111-1111-4111-8111-111111111111",
  version: 3,
};
const tool = (t: ToolsTransport, name: string) => {
  const found = artifactTools(t).find((x) => x.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};

describe("kobe-tools constants mirror the protocol", () => {
  it("matches packages/protocol artifacts.ts", () => {
    expect(TOOLS_FD).toBe(KOBE_TOOLS_FD);
    expect(TOOLS_TIMEOUT_MS).toBe(KOBE_TOOLS_TIMEOUT_MS);
    expect(MAX_CONTENT_BYTES).toBe(ARTIFACT_CONTENT_MAX_BYTES);
    expect(MAX_TITLE_LENGTH).toBe(ARTIFACT_TITLE_MAX);
    expect(OP_ARTIFACT_PUT).toBe("artifact.put");
    expect(CAPABILITY_ARTIFACTS).toBe("artifacts");
    expect(artifactTools(transport(OK).t).map((x) => x.name)).toEqual([...ARTIFACT_TOOLS]);
  });
});

describe("share_file", () => {
  const FILE: ToolsOutcome = {
    ok: true,
    file_id: "11111111-1111-4111-8111-111111111111",
    name: "report.csv",
    mime_type: "text/csv",
    size_bytes: 8,
    scan: "clean",
    created_at: "2026-10-09T10:00:00.000Z",
    sha256: "a".repeat(64),
  };

  it("mirrors the protocol's constants", () => {
    expect(OP_FILE_SHARE).toBe("file.share");
    expect(TOOL_SHARE_FILE).toBe("share_file");
    expect(CAPABILITY_FILES).toBe("files");
    expect(SHARE_PATH_MAX).toBe(FILE_SHARE_PATH_MAX);
    expect(SHARE_DESCRIPTION_MAX).toBe(FILE_SHARE_DESCRIPTION_MAX);
    expect(SHARE_NAME_MAX).toBe(UPLOAD_FILE_NAME_MAX);
  });

  it("sends file.share with the tool call id and returns the file record", async () => {
    const { t, calls } = transport(FILE);
    const input = { path: "out/report.csv", name: "r.csv", description: "Q3" };
    const result = await shareFileTool(t).execute("call_7", input);
    expect(calls).toEqual([
      { op: "file.share", tool_call_id: "call_7", tool: "share_file", input },
    ]);
    const { ok: _ok, ...record } = FILE as Record<string, unknown>;
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(record);
    expect(result.details).toEqual(record);
  });

  it("turns a server error into a tool error", async () => {
    const { t } = transport({ ok: false, error: { code: "not_synced", message: "push failed" } });
    await expect(shareFileTool(t).execute("c", { path: "a" })).rejects.toThrow(
      "not_synced: push failed",
    );
  });

  it.each([
    ["a non-object", "nope"],
    ["no path", {}],
    ["a numeric path", { path: 1 }],
    ["an empty path", { path: "" }],
    ["a long path", { path: "x".repeat(SHARE_PATH_MAX + 1) }],
    ["a long description", { path: "a", description: "x".repeat(SHARE_DESCRIPTION_MAX + 1) }],
    ["a long name", { path: "a", name: "x".repeat(SHARE_NAME_MAX + 1) }],
    ["an extra key", { path: "a", extra: 1 }],
  ])("refuses %s without sending", async (_n, input) => {
    const { t, calls } = transport(FILE);
    await expect(shareFileTool(t).execute("c", input)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses an answer that is not a file record", async () => {
    const { t } = transport(OK);
    await expect(shareFileTool(t).execute("c", { path: "a" })).rejects.toThrow(/unexpected/);
  });

  it("declares a strict schema that accepts exactly what the protocol accepts", () => {
    expect(shareFileTool(transport(FILE).t).parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["path"],
    });
    expect(shareFileInputSchema.safeParse({ path: "a" }).success).toBe(true);
  });
});

describe("create_artifact / update_artifact", () => {
  it("sends artifact.put with the tool call id and returns artifact_id and version", async () => {
    const { t, calls } = transport(OK);
    const input = { kind: "markdown", title: "Notes", content: "# hi" };
    const result = await tool(t, "create_artifact").execute("call_9", input);
    expect(calls).toEqual([
      { op: "artifact.put", tool_call_id: "call_9", tool: "create_artifact", input },
    ]);
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      artifact_id: "11111111-1111-4111-8111-111111111111",
      version: 3,
    });
    expect(result.details).toEqual({
      artifact_id: "11111111-1111-4111-8111-111111111111",
      version: 3,
    });
  });

  it("update_artifact goes through the same op", async () => {
    const { t, calls } = transport(OK);
    await tool(t, "update_artifact").execute("c", {
      artifact_id: OK.ok ? OK.artifact_id : "",
      content: "x",
    });
    expect(calls[0]).toMatchObject({ op: "artifact.put", tool: "update_artifact" });
  });

  it("turns a server error into a tool error", async () => {
    const { t } = transport({
      ok: false,
      error: { code: "not_found", message: "no such artifact" },
    });
    await expect(
      tool(t, "update_artifact").execute("c", { artifact_id: "x", content: "y" }),
    ).rejects.toThrow("not_found: no such artifact");
  });

  it("refuses content over 512 KiB without sending", async () => {
    const { t, calls } = transport(OK);
    const input = { kind: "html", title: "t", content: "x".repeat(MAX_CONTENT_BYTES + 1) };
    await expect(tool(t, "create_artifact").execute("c", input)).rejects.toThrow("larger than");
    expect(calls).toEqual([]);
  });

  it("counts content in bytes, not characters", async () => {
    const { t, calls } = transport(OK);
    const input = { kind: "html", title: "t", content: "é".repeat(MAX_CONTENT_BYTES / 2 + 1) };
    await expect(tool(t, "create_artifact").execute("c", input)).rejects.toThrow("larger than");
    expect(calls).toEqual([]);
  });

  it("refuses a call whose frame would exceed 1 MiB even though the content fits", async () => {
    const { t, calls } = transport(OK);
    // 512 KiB of control characters escapes to 6 bytes each (\u0001): over 1 MiB on the wire.
    const input = { kind: "html", title: "t", content: "\u0001".repeat(MAX_CONTENT_BYTES) };
    await expect(tool(t, "create_artifact").execute("c", input)).rejects.toThrow(
      "too large to send",
    );
    expect(calls).toEqual([]);
  });

  it("rejects a non-object input", async () => {
    const { t } = transport(OK);
    await expect(tool(t, "create_artifact").execute("c", "nope")).rejects.toThrow("invalid input");
  });

  it("registers JSON schemas that forbid extra properties", () => {
    for (const def of artifactTools(transport(OK).t)) {
      expect(def.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
  });
});

describe("frameSizeProblem", () => {
  it("accepts a normal call and the largest plain content", () => {
    expect(frameSizeProblem("c", "create_artifact", { content: "x" })).toBeUndefined();
    expect(
      frameSizeProblem("c", "create_artifact", { content: "x".repeat(MAX_CONTENT_BYTES) }),
    ).toBeUndefined();
  });

  it("measures both frames at the limit", () => {
    const room = MAX_FRAME_BYTES - Buffer.byteLength(JSON.stringify({ content: "" })) - 260;
    expect(frameSizeProblem("c", "t", { content: "x".repeat(room - 200) })).toBeUndefined();
    expect(frameSizeProblem("c", "t", { content: "x".repeat(room + 400) })).toMatch(
      /limit 1048576/,
    );
  });
});
