import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FILE_EDITS,
  FILE_EDIT_CONTENT_MAX_BYTES,
  FILE_EDIT_SUMMARY_MAX,
  PROPOSE_FILE_EDIT_TOOL,
  kobeToolsResponseSchema,
  proposeFileEditInputSchema,
} from "@kobe/protocol";
import type { ToolsOutcome } from "./client.js";
import { fileEditsEnabled, registerKobeTools } from "./extension.js";
import { parseFileEditReply, proposeFileEditTool } from "./file-edit-tool.js";
import * as P from "./protocol.js";
import type { ToolsTransport } from "./tools.js";

const SHA = "c".repeat(64);
const PROPOSED = {
  ok: true,
  op: "file_edit_propose",
  status: "awaiting_user",
  path: "notes.md",
  base_sha256: SHA,
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

const input = { path: "/workspace/notes.md", content: "# Notes\n", summary: "Tidy the notes" };

describe("propose_file_edit (KOBE-462)", () => {
  it("mirrors the protocol and sends file.edit_propose", async () => {
    expect(P.OP_FILE_EDIT_PROPOSE).toBe("file.edit_propose");
    expect(P.OPS).toContain("file.edit_propose");
    expect(P.TOOL_PROPOSE_FILE_EDIT).toBe(PROPOSE_FILE_EDIT_TOOL);
    expect(P.FILE_EDIT_CONTENT_MAX_BYTES).toBe(FILE_EDIT_CONTENT_MAX_BYTES);
    expect(P.FILE_EDIT_SUMMARY_MAX).toBe(FILE_EDIT_SUMMARY_MAX);
    expect(CAPABILITY_FILE_EDITS).toBe("file_edits");
    expect(proposeFileEditInputSchema.safeParse(input).success).toBe(true);
    const { t, calls } = transport(PROPOSED);
    const result = await proposeFileEditTool(t).execute("call_9", input);
    expect(calls).toEqual([
      { op: "file.edit_propose", tool_call_id: "call_9", tool: "propose_file_edit", input },
    ]);
    const text = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(text).toMatchObject({ status: "awaiting_user", path: "notes.md", base_sha256: SHA });
    expect(text.next).toContain("Nothing was written");
  });

  it("tells the model to propose rather than edit the viewed file", () => {
    const tool = proposeFileEditTool(transport(PROPOSED).t);
    expect(tool.promptGuidelines?.join(" ")).toMatch(/instead of editing that file/);
  });

  it("refuses bad input before sending anything", async () => {
    const { t, calls } = transport(PROPOSED);
    const tool = proposeFileEditTool(t);
    for (const bad of [
      { ...input, summary: "" },
      { ...input, path: "../etc/passwd" },
      { ...input, content: "a\u0000b" },
      { ...input, content: "x".repeat(FILE_EDIT_CONTENT_MAX_BYTES + 1) },
      { ...input, extra: true },
      { path: "a.md", content: "x" },
    ]) {
      await expect(tool.execute("call_1", bad)).rejects.toThrow(/invalid input/);
    }
    expect(calls).toEqual([]);
  });

  it("fails the tool with the server's refusal", async () => {
    const tool = proposeFileEditTool(
      transport({ ok: false, error: { code: "read_only", message: "Project files." } }).t,
    );
    await expect(tool.execute("call_1", input)).rejects.toThrow("read_only: Project files.");
  });

  it("parses only well-formed answers (fail closed)", () => {
    const reply = { id: "kt_1", ...PROPOSED };
    expect(parseFileEditReply(reply)).toEqual(reply);
    expect(kobeToolsResponseSchema.safeParse(reply).success).toBe(true);
    expect(parseFileEditReply({ ...reply, status: "applied" })).toBeUndefined();
    expect(parseFileEditReply({ ...reply, base_sha256: "x" })).toBeUndefined();
  });

  it("is registered only with the file_edits flag, read once", () => {
    const env: Record<string, string | undefined> = { KOBE_TOOLS_FILE_EDITS: "1" };
    expect(fileEditsEnabled(env)).toBe(true);
    expect(env.KOBE_TOOLS_FILE_EDITS).toBeUndefined();
    const names = (fileEdits: boolean) => {
      const registered: string[] = [];
      registerKobeTools(
        { registerTool: (tool) => registered.push((tool as { name: string }).name) },
        transport(PROPOSED).t,
        { fileEdits },
      );
      return registered;
    };
    expect(names(true)).toContain("propose_file_edit");
    expect(names(false)).not.toContain("propose_file_edit");
  });
});
