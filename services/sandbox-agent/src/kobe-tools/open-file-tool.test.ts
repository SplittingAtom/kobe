import { describe, expect, it } from "vitest";
import { OPEN_FILE_TOOL, kobeToolsResponseSchema, openFileInputSchema } from "@kobe/protocol";
import type { ToolsOutcome } from "./client.js";
import { registerKobeTools } from "./extension.js";
import { openFileTool, parseFileOpenReply } from "./open-file-tool.js";
import * as P from "./protocol.js";
import { shareFileTool, type ToolsTransport } from "./tools.js";

const OPENED = { ok: true, op: "file_open", path: "notes.md" } as const satisfies ToolsOutcome;

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

describe("open_file (KOBE-484)", () => {
  it("mirrors the protocol and sends file.open", async () => {
    expect(P.OP_FILE_OPEN).toBe("file.open");
    expect(P.OPS).toContain("file.open");
    expect(P.TOOL_OPEN_FILE).toBe(OPEN_FILE_TOOL);
    const input = { path: "/workspace/notes.md" };
    expect(openFileInputSchema.safeParse(input).success).toBe(true);
    const { t, calls } = transport(OPENED);
    const result = await openFileTool(t).execute("call_9", input);
    expect(calls).toEqual([{ op: "file.open", tool_call_id: "call_9", tool: "open_file", input }]);
    const text = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(text).toMatchObject({ status: "opened", path: "notes.md" });
    expect(result.details).toEqual({ status: "opened", path: "notes.md" });
  });

  it("guides the model: open_file to open or show a file, share_file only for a download", () => {
    const open = openFileTool(transport(OPENED).t).promptGuidelines.join(" ");
    expect(open).toMatch(/open, show or view a workspace file/);
    expect(open).toMatch(/not share_file/);
    const share = shareFileTool(transport(OPENED).t).promptGuidelines.join(" ");
    expect(share).toMatch(/only when the user wants to download/);
    expect(share).toMatch(/open_file/);
  });

  it("refuses bad input before sending anything", async () => {
    const { t, calls } = transport(OPENED);
    const tool = openFileTool(t);
    for (const bad of [{}, { path: "" }, { path: "../x" }, { path: "a\nb" }, { path: "a", x: 1 }]) {
      await expect(tool.execute("call_1", bad)).rejects.toThrow(/invalid input/);
    }
    expect(calls).toEqual([]);
  });

  it("reports a missing file as a tool error the model can relay", async () => {
    const tool = openFileTool(
      transport({ ok: false, error: { code: "not_found", message: "no such file" } }).t,
    );
    await expect(tool.execute("call_1", { path: "nope.md" })).rejects.toThrow(
      "not_found: no such file",
    );
  });

  it("parses the agent's answer and fails closed on a malformed one", () => {
    const reply = { id: "k1", ...OPENED };
    expect(kobeToolsResponseSchema.safeParse(reply).success).toBe(true);
    expect(parseFileOpenReply(reply)).toEqual(reply);
    expect(parseFileOpenReply({ id: "k1", ok: true, op: "file_open", path: "" })).toBeUndefined();
  });

  it("is registered only with file_edits", () => {
    const names = (fileEdits: boolean) => {
      const tools: string[] = [];
      registerKobeTools({ registerTool: (tool) => tools.push(tool.name) }, transport(OPENED).t, {
        fileEdits,
      });
      return tools;
    };
    expect(names(true)).toContain("open_file");
    expect(names(false)).not.toContain("open_file");
  });
});
