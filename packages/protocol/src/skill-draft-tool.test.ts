import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  kobeToolsRequestSchema,
  kobeToolsResponseSchema,
  sandboxToServerFrameSchema,
  serverToSandboxFrameSchema,
} from "./index.js";
import {
  CAPABILITY_SKILL_DRAFTS,
  SAVE_SKILL_DRAFT_TOOL,
  SKILL_DRAFT_TOOL_MAX_FILES,
  saveSkillDraftInputSchema,
  skillDraftSaveFilesSchema,
} from "./skill-draft-tool.js";

const SHA = "a".repeat(64);
const RUN = "5b0a3c64-8a5d-4d7e-9a43-2d3b7c0f1e21";
const THREAD = "0f9f4d1e-1c39-4b55-8d0e-6c2b8f1a7d33";
const DRAFT = "7a1e2b3c-4d5e-4f60-8a71-92b3c4d5e6f7";

const file = (path: string) => ({ path, rev: 3, sha256: SHA, size: 10 });

describe("save_skill_draft contract (KOBE-442)", () => {
  it("is a Kobe write tool on Kobe-owned storage, deniable like every tool", () => {
    expect(BUILTIN_TOOLS[SAVE_SKILL_DRAFT_TOOL]).toEqual({
      source: "kobe",
      risk: "write",
      scope: "kobe",
      open_world: false,
      primary_arg: "/folder",
    });
    expect(CAPABILITY_SKILL_DRAFTS).toBe("skill_drafts");
  });

  it("takes only a folder that is a skill name", () => {
    expect(saveSkillDraftInputSchema.safeParse({ folder: "weekly-report" }).success).toBe(true);
    for (const bad of ["", "../x", "/workspace/skills/x", "Weekly", "a/b", "-x"]) {
      expect(saveSkillDraftInputSchema.safeParse({ folder: bad }).success).toBe(false);
    }
    expect(saveSkillDraftInputSchema.safeParse({ folder: "x", version: "1.0.0" }).success).toBe(
      false,
    );
  });

  it("names the pushed files, at least one and at most the skill file cap, each once", () => {
    expect(skillDraftSaveFilesSchema.safeParse([file("skills/x/SKILL.md")]).success).toBe(true);
    expect(skillDraftSaveFilesSchema.safeParse([]).success).toBe(false);
    const many = Array.from({ length: SKILL_DRAFT_TOOL_MAX_FILES + 1 }, (_, i) =>
      file(`skills/x/f${i}`),
    );
    expect(skillDraftSaveFilesSchema.safeParse(many).success).toBe(false);
    expect(
      skillDraftSaveFilesSchema.safeParse([file("skills/x/a"), file("skills/x/a")]).success,
    ).toBe(false);
    expect(skillDraftSaveFilesSchema.safeParse([file("../x")]).success).toBe(false);
  });

  it("carries the wire frames both ways", () => {
    const save = {
      v: 1,
      type: "skill.draft_save",
      request_id: "sd_1",
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_1",
      tool: "save_skill_draft",
      input: { folder: "x" },
      files: [file("skills/x/SKILL.md")],
    };
    expect(sandboxToServerFrameSchema.safeParse(save).success).toBe(true);
    expect(sandboxToServerFrameSchema.safeParse({ ...save, tool: "share_file" }).success).toBe(
      false,
    );
    const ok = {
      v: 1,
      type: "skill.draft_save_result",
      request_id: "sd_1",
      ok: true,
      op: "skill_draft_save",
      draft_id: DRAFT,
      name: "x",
      created: true,
      rev: 1,
      file_count: 1,
    };
    expect(serverToSandboxFrameSchema.safeParse(ok).success).toBe(true);
    const failed = {
      v: 1,
      type: "skill.draft_save_result",
      request_id: "sd_1",
      ok: false,
      error: { code: "invalid_skill", message: "SKILL.md has no description." },
    };
    expect(serverToSandboxFrameSchema.safeParse(failed).success).toBe(true);
  });

  it("is a kobe-tools op with its own answer", () => {
    expect(
      kobeToolsRequestSchema.safeParse({
        id: "1",
        op: "skill.draft_save",
        tool_call_id: "call_1",
        tool: "save_skill_draft",
        input: { folder: "x" },
      }).success,
    ).toBe(true);
    expect(
      kobeToolsResponseSchema.safeParse({
        id: "1",
        ok: true,
        op: "skill_draft_save",
        draft_id: DRAFT,
        name: "x",
        created: false,
        rev: 4,
        file_count: 3,
      }).success,
    ).toBe(true);
  });
});
