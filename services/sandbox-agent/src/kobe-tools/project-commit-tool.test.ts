import { describe, expect, it } from "vitest";
import {
  PROJECT_COMMIT_MESSAGE_MAX as PROTOCOL_MESSAGE_MAX,
  commitProjectToolInputSchema,
  kobeToolsResponseSchema,
} from "@kobe/protocol";
import type { ToolsOutcome } from "./client.js";
import { registerKobeTools } from "./extension.js";
import { commitOutcomeText, commitProjectTool } from "./project-commit-tool.js";
import { parseProjectCommitReply } from "./project-reply.js";
import * as P from "./protocol.js";
import type { ToolsTransport } from "./tools.js";

const COMMITTED = {
  ok: true,
  op: "project_commit",
  outcome: { status: "committed", seq: 7 },
} as const satisfies ToolsOutcome;

function transport(outcome: ToolsOutcome) {
  const calls: { call: unknown; options: unknown }[] = [];
  const t: ToolsTransport = {
    request: (call, options) => {
      calls.push({ call, options });
      return Promise.resolve(outcome);
    },
  };
  return { t, calls };
}

describe("commit_project (KOBE-580)", () => {
  it("mirrors the protocol and sends project.commit with the message only", async () => {
    expect(P.OP_PROJECT_COMMIT).toBe("project.commit");
    expect(P.OPS).toContain("project.commit");
    expect(P.TOOL_COMMIT_PROJECT).toBe("commit_project");
    expect(P.PROJECT_COMMIT_MESSAGE_MAX).toBe(PROTOCOL_MESSAGE_MAX);
    const { t, calls } = transport(COMMITTED);
    const input = { message: "Add the Q3 numbers" };
    expect(commitProjectToolInputSchema.safeParse(input).success).toBe(true);
    const result = await commitProjectTool(t).execute("call_1", input);
    expect(calls).toEqual([
      {
        call: { op: "project.commit", tool_call_id: "call_1", tool: "commit_project", input },
        options: { timeoutMs: P.PROJECT_COMMIT_TIMEOUT_MS },
      },
    ]);
    expect(result.content[0]?.text).toBe("Committed as #7.");
    expect(result.details).toEqual({ status: "committed", seq: 7 });
  });

  it("tells the model what each outcome means", () => {
    expect(commitOutcomeText({ status: "committed", seq: 3 })).toBe("Committed as #3.");
    expect(commitOutcomeText({ status: "commit_conflict", head_seq: 9 })).toMatch(
      /moved on to #9.*Ask the user to Update/,
    );
    expect(commitOutcomeText({ status: "nothing_to_commit" })).toMatch(/^Nothing to commit/);
    expect(commitOutcomeText({ status: "pending_approval" })).toMatch(/^Awaiting approval/);
  });

  it("rejects bad input before anything is sent, and relays a refusal with its reason", async () => {
    const { t, calls } = transport(COMMITTED);
    const tool = commitProjectTool(t);
    for (const bad of [
      null,
      {},
      { message: "" },
      { message: "   " },
      { message: 3 },
      { message: "x".repeat(PROTOCOL_MESSAGE_MAX + 1) },
      { message: "ok", project: "other" },
    ]) {
      await expect(tool.execute("c", bad)).rejects.toThrow(/invalid input/);
    }
    expect(calls).toEqual([]);
    // D32: an auto or scheduled run is refused by the server; the tool relays the reason.
    const refused = transport({
      ok: false,
      error: { code: "not_allowed", message: "commits are refused in runs that never wait" },
    });
    await expect(commitProjectTool(refused.t).execute("c", { message: "m" })).rejects.toThrow(
      "not_allowed: commits are refused in runs that never wait",
    );
    await expect(
      commitProjectTool(transport({ ok: true, artifact_id: "x", version: 1 }).t).execute("c", {
        message: "m",
      }),
    ).rejects.toThrow(/unexpected/);
  });

  it("is registered only with projects and Pi's active-tools API (listed per run by the hooks)", () => {
    const names = (options: { projects?: boolean }, activeTools: boolean) => {
      const seen: string[] = [];
      const api = {
        registerTool: (tool: { name: string }) => seen.push(tool.name),
        ...(activeTools
          ? { on: () => undefined, getActiveTools: () => [], setActiveTools: () => undefined }
          : {}),
      };
      registerKobeTools(api, transport(COMMITTED).t, options);
      return seen;
    };
    expect(names({ projects: true }, true)).toContain("commit_project");
    expect(names({ projects: true }, false)).not.toContain("commit_project");
    expect(names({}, true)).not.toContain("commit_project");
  });

  it("parses the reply as the protocol defines it and fails closed on a malformed one", () => {
    for (const outcome of [
      { status: "committed", seq: 2 },
      { status: "commit_conflict", head_seq: 4 },
      { status: "nothing_to_commit" },
      { status: "pending_approval" },
    ]) {
      const reply = { id: "kt_1", ok: true, op: "project_commit", outcome };
      expect(kobeToolsResponseSchema.safeParse(reply).success).toBe(true);
      expect(parseProjectCommitReply(reply)).toEqual(reply);
    }
    for (const outcome of [
      { status: "committed" },
      { status: "committed", seq: 0 },
      { status: "committed", seq: 1, extra: true },
      { status: "commit_conflict", head_seq: "3" },
      { status: "nothing_to_commit", seq: 1 },
      { status: "weird" },
      "committed",
    ]) {
      expect(parseProjectCommitReply({ id: "kt_1", ok: true, op: "project_commit", outcome })).toBe(
        undefined,
      );
    }
  });
});
