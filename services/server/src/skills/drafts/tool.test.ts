import { describe, expect, it } from "vitest";
import { SKILL_DRAFT_TOOL_MAX_BYTES, SKILL_DRAFT_TOOL_MAX_FILES } from "@kobe/protocol";
import { DRAFT_LIMITS } from "./files.js";

describe("save_skill_draft limits (KOBE-442)", () => {
  it("are the draft's own: the agent checks the same caps before it pushes", () => {
    expect(SKILL_DRAFT_TOOL_MAX_FILES).toBe(DRAFT_LIMITS.maxFiles);
    expect(SKILL_DRAFT_TOOL_MAX_BYTES).toBe(DRAFT_LIMITS.maxDraftBytes);
  });
});
