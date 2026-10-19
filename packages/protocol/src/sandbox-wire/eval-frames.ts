import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import { EVAL_MAX_FILES_PER_CASE, EVAL_MAX_OUTPUTS } from "../skill-evals/cases.js";
import { SHA256_HEX_PATTERN } from "../skill-package/layout.js";
import { EVAL_OUTPUT_READ_MAX_BYTES, evalWorkspaceSnapshotSchema } from "../skill-evals/outputs.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/**
 * Skill eval commands (KOBE-325, SK16; `eval.read` KOBE-326), sent only to a skill eval's own
 * ephemeral sandbox (a session token with `eval_thread`), behind hello capability
 * {@link CAPABILITY_SKILL_EVAL}. Each is answered with `command.result`. Same shape as `frame()` in
 * frames.ts.
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
  roots: z
    .array(
      z
        .string()
        .max(1024)
        .refine(
          (r) => r === "" || (r.endsWith("/") && workspacePath.safeParse(r.slice(0, -1)).success),
          "a directory relative to /workspace (ending in /), or empty for all of it",
        ),
    )
    .max(EVAL_MAX_OUTPUTS),
  hash_paths: z.array(workspacePath).max(EVAL_MAX_FILES_PER_CASE),
});

/** What a successful `eval.snapshot` returns in `command.result.data`. */
export const evalSnapshotResultSchema = evalWorkspaceSnapshotSchema;

/** Files one `eval.read` names at most, and the bytes it returns in all (base64 in the frame). */
export const EVAL_READ_MAX_FILES = 100;
export const EVAL_READ_MAX_TOTAL_BYTES = 1024 * 1024;

/**
 * Server -> eval sandbox, after the checks passed and before the judge (KOBE-326): the bytes of
 * the matched output files, so the server can show them to the judge (contract KOBE-324
 * `outputs.ts`). The request names only paths and walked sizes: nothing of the judge's messages,
 * rubric or nonce ever reaches the sandbox. For each file the agent opens it with `O_NOFOLLOW` and
 * `O_NONBLOCK`, refuses it unless no segment on the way is a link and `fstat` shows a regular file
 * of exactly `size` bytes with one link, on the workspace volume, and reads at most `EVAL_OUTPUT_READ_MAX_BYTES` of it, in order, while
 * the whole reply stays within {@link EVAL_READ_MAX_TOTAL_BYTES} (later files are `skipped`).
 */
export const evalReadFrameSchema = frame("eval.read", {
  command_id: idSchema,
  thread_id: uuidSchema,
  files: z
    .array(z.strictObject({ path: workspacePath, size: z.number().int().min(0) }))
    .min(1)
    .max(EVAL_READ_MAX_FILES),
});

/**
 * Why a file was not read: a link on the way or a hard link (`nlink > 1`), not a regular file,
 * another size, not on the workspace volume, unopenable.
 */
export const EVAL_READ_REFUSALS = [
  "link",
  "not_regular",
  "size_changed",
  "off_volume",
  "unreadable",
] as const;

/** What a successful `eval.read` returns in `command.result.data` (untrusted: checked again). */
export const evalReadResultSchema = z.strictObject({
  files: z
    .array(
      z.discriminatedUnion("status", [
        z.strictObject({
          path: workspacePath,
          status: z.literal("read"),
          /** Base64 of the bytes read (at most `EVAL_OUTPUT_READ_MAX_BYTES`). */
          data: z
            .string()
            .max(Math.ceil(EVAL_OUTPUT_READ_MAX_BYTES / 3) * 4)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
          /** The file is longer than what was read. */
          truncated: z.boolean(),
        }),
        z.strictObject({
          path: workspacePath,
          status: z.literal("refused"),
          reason: z.enum(EVAL_READ_REFUSALS),
        }),
        z.strictObject({ path: workspacePath, status: z.literal("skipped") }),
      ]),
    )
    .max(EVAL_READ_MAX_FILES),
});

export type EvalPrepareFrame = z.infer<typeof evalPrepareFrameSchema>;
export type EvalSnapshotFrame = z.infer<typeof evalSnapshotFrameSchema>;
export type EvalReadFrame = z.infer<typeof evalReadFrameSchema>;
export type EvalReadResult = z.infer<typeof evalReadResultSchema>;
