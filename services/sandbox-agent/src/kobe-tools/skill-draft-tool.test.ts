import { describe, expect, it } from "vitest";
import {
  CAPABILITY_SKILL_DRAFTS,
  SAVE_SKILL_DRAFT_TOOL,
  SKILL_NAME_PATTERN,
  saveSkillDraftInputSchema,
} from "@kobe/protocol";
import type { ToolsOutcome } from "./client.js";
import { registerKobeTools, skillDraftsEnabled } from "./extension.js";
import * as P from "./protocol.js";
import { parseSkillDraftReply, saveSkillDraftTool } from "./skill-draft-tool.js";
import type { ToolsTransport } from "./tools.js";

const SAVED = {
  ok: true,
  op: "skill_draft_save",
  draft_id: "8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b",
  name: "close-helper",
  created: true,
  rev: 1,
  file_count: 3,
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

describe("save_skill_draft (KOBE-442)", () => {
  it("mirrors the protocol and sends skill.draft_save", async () => {
    expect(P.OP_SKILL_DRAFT_SAVE).toBe("skill.draft_save");
    expect(P.OPS).toContain("skill.draft_save");
    expect(P.TOOL_SAVE_SKILL_DRAFT).toBe(SAVE_SKILL_DRAFT_TOOL);
    expect(P.SKILL_NAME_RE.source).toBe(SKILL_NAME_PATTERN.source);
    expect(CAPABILITY_SKILL_DRAFTS).toBe("skill_drafts");
    const { t, calls } = transport(SAVED);
    const input = { folder: "close-helper" };
    expect(saveSkillDraftInputSchema.safeParse(input).success).toBe(true);
    const result = await saveSkillDraftTool(t).execute("call_9", input);
    expect(calls).toEqual([
      { op: "skill.draft_save", tool_call_id: "call_9", tool: "save_skill_draft", input },
    ]);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
      draft_id: SAVED.draft_id,
      name: "close-helper",
      created: true,
      rev: 1,
      file_count: 3,
      next: expect.stringContaining("Workbench") as unknown,
    });
  });

  it("tells the model when a shared or edited draft made a new one", async () => {
    const tool = saveSkillDraftTool(transport({ ...SAVED, new_because: "shared" }).t);
    const result = await tool.execute("c", { folder: "close-helper" });
    const body = JSON.parse(result.content[0]?.text ?? "{}") as {
      new_because: string;
      next: string;
    };
    expect(body.new_because).toBe("shared");
    expect(body.next).toMatch(/shared or edited, so this is a new draft/);
  });

  it("tells the model the draft is private and what the member does next", () => {
    const tool = saveSkillDraftTool(transport(SAVED).t);
    const text = [tool.description, ...tool.promptGuidelines].join(" ");
    expect(text).toMatch(/private/);
    expect(text).toMatch(/Workbench/);
    expect(text).not.toMatch(/My skills/);
  });

  it("rejects bad input before anything is sent, and surfaces a server error", async () => {
    const { t, calls } = transport(SAVED);
    const tool = saveSkillDraftTool(t);
    for (const bad of [
      null,
      {},
      { folder: "" },
      { folder: "/workspace/skills/x" },
      { folder: "../x" },
      { folder: "x", extra: 1 },
    ]) {
      await expect(tool.execute("c", bad)).rejects.toThrow(/invalid input/);
    }
    expect(calls).toEqual([]);
    const refused = transport({ ok: false, error: { code: "invalid_skill", message: "no" } });
    await expect(saveSkillDraftTool(refused.t).execute("c", { folder: "x" })).rejects.toThrow(
      /invalid_skill/,
    );
    await expect(
      saveSkillDraftTool(transport({ ok: true, artifact_id: "x", version: 1 }).t).execute("c", {
        folder: "x",
      }),
    ).rejects.toThrow(/unexpected/);
  });

  it("is registered only when the agent enabled skill drafts", () => {
    const names = (options: { skillDrafts?: boolean }) => {
      const seen: string[] = [];
      registerKobeTools(
        { registerTool: (tool) => seen.push(tool.name) },
        transport(SAVED).t,
        options,
      );
      return seen;
    };
    expect(names({ skillDrafts: true })).toContain("save_skill_draft");
    expect(names({})).not.toContain("save_skill_draft");
    const env: Record<string, string | undefined> = { [P.TOOLS_SKILL_DRAFTS_ENV]: "1" };
    expect(skillDraftsEnabled(env)).toBe(true);
    expect(env[P.TOOLS_SKILL_DRAFTS_ENV]).toBeUndefined();
    expect(skillDraftsEnabled({ [P.TOOLS_SKILL_DRAFTS_ENV]: "yes" })).toBe(false);
  });

  it("parses the reply and fails closed on a malformed one", () => {
    expect(parseSkillDraftReply({ id: "kt_1", ...SAVED })).toEqual({ id: "kt_1", ...SAVED });
    expect(parseSkillDraftReply({ id: "kt_1", ...SAVED, created: "yes" })).toBeUndefined();
    expect(parseSkillDraftReply({ id: "kt_1", ...SAVED, rev: 1.5 })).toBeUndefined();
    expect(parseSkillDraftReply({ id: "kt_1", ...SAVED, draft_id: 3 })).toBeUndefined();
    expect(parseSkillDraftReply({ id: "kt_1", ...SAVED, new_because: "edited" })).toEqual({
      id: "kt_1",
      ...SAVED,
      new_because: "edited",
    });
    expect(parseSkillDraftReply({ id: "kt_1", ...SAVED, new_because: "x" })).toBeUndefined();
  });
});
