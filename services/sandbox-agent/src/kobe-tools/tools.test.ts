import {
  ARTIFACT_CONTENT_MAX_BYTES,
  ARTIFACT_TITLE_MAX,
  ARTIFACT_TOOLS,
  KOBE_TOOLS_FD,
  KOBE_TOOLS_TIMEOUT_MS,
  CAPABILITY_ARTIFACTS,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { frameSizeProblem } from "./frame-size.js";
import {
  MAX_CONTENT_BYTES,
  MAX_FRAME_BYTES,
  MAX_TITLE_LENGTH,
  OP_ARTIFACT_PUT,
  TOOLS_FD,
  TOOLS_TIMEOUT_MS,
  type ToolsRequest,
} from "./protocol.js";
import { artifactTools, type ToolsTransport } from "./tools.js";
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
