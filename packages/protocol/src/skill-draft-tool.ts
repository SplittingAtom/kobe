import { z } from "zod";
import { idSchema, uuidSchema } from "./common.js";
import { SKILL_NAME_PATTERN } from "./skill-package/layout.js";
import { sha256HexSchema, workspacePathSchema } from "./sandbox-wire/workspace-sync.js";

/**
 * `save_skill_draft` contract (KOBE-442). Additive: an agent without
 * {@link CAPABILITY_SKILL_DRAFTS} never registers the tool, and the server refuses the frame
 * from a connection that did not announce it.
 *
 * The model names a folder `/workspace/skills/<folder>/` (what skill-creator builds); the server
 * makes it the member's **private Workbench draft**, as Save to Workbench (KOBE-322) does, and
 * nothing else: no version save, no review submission, no eval. Push-then-save, like `share_file`
 * (files.ts):
 *  1. `save_skill_draft` runs through kobe-policy `policy.check` like any tool (`primary_arg`
 *     `/folder`; a deny rule can refuse it).
 *  2. kobe-tools sends `{op:"skill.draft_save"}` on fd 4.
 *  3. The agent walks the folder (no symlinks, nothing under `.kobe/` or skipped directories),
 *     pushes each file through workspace sync and keeps each applied entry.
 *  4. It sends `skill.draft_save` with `files` = those entries and waits for the result.
 *  5. The server checks: capability; run active and leased; the allowed input for `tool_call_id`
 *     equals `input`; every listed path is under `skills/<folder>/` and its live manifest row has
 *     exactly that `rev`, `sha256` and size (else `not_synced`). It reads only those objects (each
 *     checked against its hash), validates them as an upload, and creates the draft
 *     (`started_from: thread`, `from_thread_id` = the run's thread) or, when this conversation
 *     already saved a skill of that name, replaces that draft's files (one new revision).
 *  6. The answer is the tool result; the web shows it as an Open in Workbench card.
 */

/** `hello.capabilities` entry of an agent that registers `save_skill_draft`. */
export const CAPABILITY_SKILL_DRAFTS = "skill_drafts";
export const SAVE_SKILL_DRAFT_TOOL = "save_skill_draft";

/** Files one save names: the skill package's own file cap (`SKILL_LIMITS.maxFiles`). */
export const SKILL_DRAFT_TOOL_MAX_FILES = 200;
/** All files of one save: a draft's size cap (`SKILL_DRAFT_MAX_BYTES`, db); the agent checks first. */
export const SKILL_DRAFT_TOOL_MAX_BYTES = 5 * 1024 * 1024;
/** A listed path's length; keeps the frame small (200 x 512 bytes plus hashes < 256 KiB). */
export const SKILL_DRAFT_TOOL_PATH_MAX = 512;

/** Model-facing input: the folder name under `/workspace/skills/`. */
export const saveSkillDraftInputSchema = z.strictObject({
  folder: z.string().regex(SKILL_NAME_PATTERN, "a skill name: lowercase letters, digits, hyphens"),
});
export type SaveSkillDraftInput = z.infer<typeof saveSkillDraftInputSchema>;

/** One pushed file (as `share_file`'s evidence): the server needs its live row unchanged. */
export const skillDraftSaveFileSchema = z.strictObject({
  path: workspacePathSchema.pipe(z.string().max(SKILL_DRAFT_TOOL_PATH_MAX)),
  rev: z.number().int().positive(),
  sha256: sha256HexSchema,
  size: z.number().int().nonnegative(),
});
export type SkillDraftSaveFile = z.infer<typeof skillDraftSaveFileSchema>;

export const skillDraftSaveFilesSchema = z
  .array(skillDraftSaveFileSchema)
  .min(1)
  .max(SKILL_DRAFT_TOOL_MAX_FILES)
  .refine((files) => new Set(files.map((f) => f.path)).size === files.length, "a path twice");

/** Server answer codes; open on the sandbox side (any `^[a-z][a-z0-9_]{0,63}$` decodes). */
export const SKILL_DRAFT_SAVE_ERROR_CODES = [
  "not_allowed",
  "forbidden", // the member's team role allows no drafts
  "not_synced", // not pushed, or changed since the push
  "not_found", // the folder has no files
  "invalid_skill", // the upload's validation refused it (message says why)
  "too_large",
  "too_many_files",
  "draft_limit",
  "rate_limited",
  "storage_failed",
] as const;
export const skillDraftSaveErrorSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().max(2000),
});

/** Success answer (frame and kobe-tools response, flat). `created`: false = updated in place. */
export const skillDraftSaveOkFields = {
  ok: z.literal(true),
  op: z.literal("skill_draft_save"),
  draft_id: uuidSchema,
  name: z.string().regex(SKILL_NAME_PATTERN),
  created: z.boolean(),
  rev: z.number().int().positive(),
  file_count: z.number().int().positive(),
} as const;
export const skillDraftSaveFailFields = {
  ok: z.literal(false),
  error: skillDraftSaveErrorSchema,
} as const;

export const skillDraftCallShape = {
  tool: z.literal(SAVE_SKILL_DRAFT_TOOL),
  input: saveSkillDraftInputSchema,
} as const;

/** kobe-tools request (fd 4); member of `kobeToolsRequestSchema`. */
export const skillDraftToolsRequestSchema = z.strictObject({
  id: idSchema,
  op: z.literal("skill.draft_save"),
  tool_call_id: idSchema,
  ...skillDraftCallShape,
});
export type SkillDraftToolsRequest = z.infer<typeof skillDraftToolsRequestSchema>;

export const skillDraftToolInputSchema = {
  [SAVE_SKILL_DRAFT_TOOL]: saveSkillDraftInputSchema,
} as const;
