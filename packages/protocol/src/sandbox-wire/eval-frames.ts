import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import { EVAL_MAX_FILES_PER_CASE, EVAL_MAX_OUTPUTS } from "../skill-evals/cases.js";
import { SHA256_HEX_PATTERN } from "../skill-package/layout.js";
import { evalWorkspaceSnapshotSchema } from "../skill-evals/outputs.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * Skill eval commands (KOBE-325, SK16), sent only to a skill eval's own ephemeral sandbox (a
 * session token with `eval_thread`), behind hello capability {@link CAPABILITY_SKILL_EVAL}. Both
 * are answered with `command.result`. Same shape as `frame()` in frames.ts.
 */
export const CAPABILITY_SKILL_EVAL = "skill_eval";

/** The fixtures route on the sandbox listener: `GET <prefix>?path=<workspace path>`. */
export const SKILL_EVAL_FIXTURES_PATH = "/v1/sandbox/skill-evals/fixtures";

function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/** A path relative to `/workspace`: no `..`, `.` or empty segment, no leading slash. */
const workspacePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) => !p.startsWith("/") && !p.split("/").some((s) => s === "" || s === "." || s === ".."),
    "a path relative to /workspace",
  );

/**
 * Server -> eval sandbox: copy the case's fixtures into the empty `/workspace` before its run.
 * The agent fetches each from {@link SKILL_EVAL_FIXTURES_PATH} (its session token: only its own
 * case's files are served), checks size and SHA-256, and writes it without following any link.
 * `command.result` ok when every file is in place; an error otherwise (the execution errors).
 */
export const evalPrepareFrameSchema = frame("eval.prepare", {
  command_id: idSchema,
  thread_id: uuidSchema,
  files: z
    .array(
      z.strictObject({
        path: workspacePath,
        sha256: z.string().regex(SHA256_HEX_PATTERN),
        size: z.number().int().min(0),
      }),
    )
    .max(EVAL_MAX_FILES_PER_CASE),
});

/**
 * Server -> eval sandbox, after the run: the after-snapshot of `/workspace` (KOBE-324
 * `EvalWorkspaceSnapshot`): one walk per root, `lstat` only, never following a link (a linked
 * root or parent is recorded, never entered), regular files only, no `skills` or hidden segment,
 * SHA-256 only for `hash_paths` (the fixtures). Answered by `command.result` whose data is the
 * snapshot.
 */
export const evalSnapshotFrameSchema = frame("eval.snapshot", {
  command_id: idSchema,
  thread_id: uuidSchema,
  /** Literal directories to walk (`evalOutputWalkRoots`; `""` is all of `/workspace`). */
  roots: z.array(z.string().max(1024)).max(EVAL_MAX_OUTPUTS),
  hash_paths: z.array(workspacePath).max(EVAL_MAX_FILES_PER_CASE),
});

/** What a successful `eval.snapshot` returns in `command.result.data`. */
export const evalSnapshotResultSchema = evalWorkspaceSnapshotSchema;

export type EvalPrepareFrame = z.infer<typeof evalPrepareFrameSchema>;
export type EvalSnapshotFrame = z.infer<typeof evalSnapshotFrameSchema>;
