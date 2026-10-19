import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import {
  skillDraftCallShape,
  skillDraftSaveFailFields,
  skillDraftSaveFilesSchema,
  skillDraftSaveOkFields,
} from "../skill-draft-tool.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/** Skill draft frames (KOBE-442, skill-draft-tool.ts), behind hello capability `skill_drafts`. */
function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/**
 * Sandbox -> server: the `save_skill_draft` call kobe-policy let through, sent AFTER the agent
 * pushed every file of the folder through workspace sync (push-then-save). Answered by
 * `skill.draft_save_result` for the same `request_id`. A small frame.
 */
export const skillDraftSaveFrameSchema = frame("skill.draft_save", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  ...skillDraftCallShape,
  files: skillDraftSaveFilesSchema,
});

/** Server -> sandbox; `error.code` is open (known: `SKILL_DRAFT_SAVE_ERROR_CODES`). */
export const skillDraftSaveResultFrameSchema = z.union([
  frame("skill.draft_save_result", { request_id: idSchema, ...skillDraftSaveOkFields }),
  frame("skill.draft_save_result", { request_id: idSchema, ...skillDraftSaveFailFields }),
]);

export type SkillDraftSaveFrame = z.infer<typeof skillDraftSaveFrameSchema>;
export type SkillDraftSaveResultFrame = z.infer<typeof skillDraftSaveResultFrameSchema>;
