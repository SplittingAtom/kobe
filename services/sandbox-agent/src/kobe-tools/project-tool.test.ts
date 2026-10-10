import { describe, expect, it } from "vitest";
import {
  CAPABILITY_PROJECTS,
  PROJECT_PROPOSE_REASON_MAX as PROTOCOL_REASON_MAX,
  proposeProjectFileInputSchema,
} from "@kobe/protocol";
import type { ToolsOutcome } from "./client.js";
import { proposeProjectFileTool } from "./project-tool.js";
import { parseProjectReply } from "./project-reply.js";
import * as P from "./protocol.js";
import { registerKobeTools } from "./extension.js";
import type { ToolsTransport } from "./tools.js";

const PENDING = {
  ok: true,
  op: "project_file_propose",
  status: "pending_approval",
  proposal_id: "8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b",
  project_id: "7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a",
  path: "docs/spec.md",
} as const satisfies ToolsOutcome;

function transport(outcome: ToolsOutcome) {
  const calls: unknown[] = [];
  const t: ToolsTransport = {
    request: (call) => {
      calls.push(call);
      return Promise.resolve(outcome);
    },
  };
  return { t, calls };
}

describe("propose_project_file", () => {
  it("mirrors the protocol and sends project.file_propose", async () => {
    expect(P.OP_PROJECT_FILE_PROPOSE).toBe("project.file_propose");
    expect(P.OPS).toContain("project.file_propose");
    expect(P.TOOL_PROPOSE_PROJECT_FILE).toBe("propose_project_file");
    expect(P.PROJECT_PROPOSE_REASON_MAX).toBe(PROTOCOL_REASON_MAX);
    expect(CAPABILITY_PROJECTS).toBe("projects");
    const { t, calls } = transport(PENDING);
    const input = { path: "notes/spec.md", folder: "docs", reason: "keep it" };
    expect(proposeProjectFileInputSchema.safeParse(input).success).toBe(true);
    const result = await proposeProjectFileTool(t).execute("call_9", input);
    expect(calls).toEqual([
      { op: "project.file_propose", tool_call_id: "call_9", tool: "propose_project_file", input },
    ]);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
      status: "pending_approval",
      path: "docs/spec.md",
    });
  });

  it("rejects bad input before anything is sent, and surfaces a server error", async () => {
    const { t, calls } = transport(PENDING);
    const tool = proposeProjectFileTool(t);
    for (const bad of [
      null,
      {},
      { path: "" },
      { path: "a", extra: 1 },
      { path: "a", reason: "" },
      { path: "a", folder: 3 },
    ]) {
      await expect(tool.execute("c", bad)).rejects.toThrow(/invalid input/);
    }
    expect(calls).toEqual([]);
    const refused = transport({ ok: false, error: { code: "not_allowed", message: "no" } });
    await expect(proposeProjectFileTool(refused.t).execute("c", { path: "a" })).rejects.toThrow(
      /not_allowed/,
    );
    await expect(
      proposeProjectFileTool(transport({ ok: true, artifact_id: "x", version: 1 }).t).execute("c", {
        path: "a",
      }),
    ).rejects.toThrow(/unexpected/);
  });

  it("is registered only when the agent enabled projects", () => {
    const names = (options: { projects?: boolean }) => {
      const seen: string[] = [];
      registerKobeTools(
        { registerTool: (tool) => seen.push(tool.name) },
        transport(PENDING).t,
        options,
      );
      return seen;
    };
    expect(names({ projects: true })).toContain("propose_project_file");
    expect(names({})).not.toContain("propose_project_file");
  });

  it("parses the reply and fails closed on a malformed one", () => {
    expect(parseProjectReply({ id: "kt_1", ...PENDING })).toEqual({ id: "kt_1", ...PENDING });
    expect(parseProjectReply({ id: "kt_1", ...PENDING, status: "weird" })).toBeUndefined();
    expect(parseProjectReply({ id: "kt_1", ...PENDING, proposal_id: 3 })).toBeUndefined();
    expect(parseProjectReply({ id: "kt_1", ...PENDING, file: "x" })).toBeUndefined();
  });
});
