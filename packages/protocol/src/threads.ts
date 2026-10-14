import { z } from "zod";
import { idSchema, utf8ByteLength, uuidSchema } from "./common.js";

/**
 * Thread compaction (KOBE-212, CE15): `POST /v1/threads/{id}/compact` and the shapes the
 * `thread.compact` wire command (sandbox-wire/frames.ts) shares with it. Pi owns compaction: the
 * sandbox agent maps the command onto Pi 1.0.x RPC `{"type":"compact","customInstructions"?}`
 * (verified against the pinned 1.0.0 tarball, see docs/ledger/KOBE-212.md). Pi appends a
 * `compaction` session entry (summary, firstKeptEntryId, tokensBefore, ...) that the server
 * mirrors like any other entry; Kobe never summarizes server-side.
 *
 * A compaction is a run (kind compaction) created through the usual lease and run-start
 * transaction, so its summary calls are billed and budget-checked like any run, and the one
 * active run per thread rule refuses a busy thread (`thread_busy`): Pi's `compact` aborts whatever
 * the session is doing first. The agent refuses again if it sees another run. Raw `pi.command`
 * cannot compact (pi-rpc.ts).
 */

/**
 * Hello capability: the agent understands `thread.compact` and answers `thread.compact_result`.
 * The server sends the command only to agents that announced it and `run_token`.
 */
export const CAPABILITY_THREAD_COMPACT = "thread_compact";

/** Longest `focus`, in UTF-16 code units (Pi appends it to its summary prompt). */
export const THREAD_COMPACT_FOCUS_MAX_CHARS = 1000;

/** Longest summary echoed back (UTF-8 bytes); the mirrored `compaction` entry is authoritative. */
export const THREAD_COMPACT_SUMMARY_MAX_BYTES = 256 * 1024;

// C0 controls other than tab, LF and CR, DEL, the line/paragraph separators and bidi controls.
const FOCUS_REFUSED_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * What the member wants the summary to keep. Passed to Pi verbatim as `customInstructions`; Pi
 * 1.0.0 appends `\n\nAdditional focus: <focus>` to its summarization prompt. Kept as sent (no
 * trimming), but must not be blank.
 */
export const threadCompactFocusSchema = z
  .string()
  .min(1)
  .max(THREAD_COMPACT_FOCUS_MAX_CHARS)
  .refine((s) => /\S/.test(s), { message: "focus is blank" })
  .refine((s) => !FOCUS_REFUSED_CHARS.test(s), { message: "focus has control characters" });

/** Pi's `CompactionResult` in Kobe's casing, shared by the wire reply and the HTTP response. */
export const threadCompactResultShape = {
  /**
   * The summary Pi wrote. Absent when it is over {@link THREAD_COMPACT_SUMMARY_MAX_BYTES} (the
   * compaction still happened; read the mirrored entry).
   */
  summary: z
    .string()
    .min(1)
    .refine((s) => utf8ByteLength(s) <= THREAD_COMPACT_SUMMARY_MAX_BYTES, {
      message: `summary is over ${THREAD_COMPACT_SUMMARY_MAX_BYTES} bytes`,
    })
    .optional(),
  /** Pi `firstKeptEntryId`: the first entry still sent to the model after the summary. */
  first_kept_entry_id: idSchema,
  /** Pi `tokensBefore`: context tokens before compaction. */
  tokens_before: z.number().int().nonnegative(),
  /** Pi `estimatedTokensAfter`: a heuristic estimate, not a provider count. */
  estimated_tokens_after: z.number().int().nonnegative().optional(),
};

/** Body of `POST /v1/threads/{id}/compact`. */
export const compactThreadRequestSchema = z.strictObject({
  focus: threadCompactFocusSchema.optional(),
});
export type CompactThreadRequest = z.infer<typeof compactThreadRequestSchema>;

/** 200 answer: the thread is compacted; the `compaction` entry follows in the thread's entries. */
export const compactThreadResponseSchema = z.strictObject({
  thread_id: uuidSchema,
  ...threadCompactResultShape,
});
export type CompactThreadResponse = z.infer<typeof compactThreadResponseSchema>;

/**
 * Error codes of `POST /v1/threads/{id}/compact`, next to the usual `thread_not_found` (404) and
 * `forbidden` (403). `nothing_to_compact`: Pi found nothing to summarize (session too small, or
 * the last entry already is a compaction).
 */
export const COMPACT_THREAD_ERROR_CODES = [
  "thread_busy",
  "sandbox_unavailable",
  "nothing_to_compact",
  "model_not_configured",
  "compaction_failed",
] as const;
export const compactThreadErrorCodeSchema = z.enum(COMPACT_THREAD_ERROR_CODES);
export type CompactThreadErrorCode = z.infer<typeof compactThreadErrorCodeSchema>;

/** `sandbox_unavailable` is retryable; `compaction_failed` is the summary's model call failing. */
export const COMPACT_THREAD_ERROR_HTTP_STATUS = {
  thread_busy: 409,
  sandbox_unavailable: 503,
  nothing_to_compact: 409,
  model_not_configured: 409,
  compaction_failed: 502,
} as const satisfies Record<CompactThreadErrorCode, number>;

/**
 * The one message per code. The server never relays the sandbox's or Pi's text (it can carry
 * gateway or provider error bodies); it logs that and answers with these.
 */
export const COMPACT_THREAD_ERROR_MESSAGES = {
  thread_busy: "This thread is busy. Wait for the current run to finish, then compact it.",
  sandbox_unavailable: "Your workspace is not available right now. Try again in a moment.",
  nothing_to_compact:
    "There is nothing to compact yet: the conversation is short or was just compacted.",
  model_not_configured:
    "No model is enabled for your team yet. Ask a team admin to enable one in the team's model settings.",
  compaction_failed: "The conversation could not be compacted. Try again in a moment.",
} as const satisfies Record<CompactThreadErrorCode, string>;

const compactError = <C extends CompactThreadErrorCode>(code: C) =>
  z.strictObject({
    code: z.literal(code),
    message: z.literal(COMPACT_THREAD_ERROR_MESSAGES[code]),
  });

/** Error body: a known code with exactly its fixed message. */
export const compactThreadErrorSchema = z.discriminatedUnion("code", [
  compactError("thread_busy"),
  compactError("sandbox_unavailable"),
  compactError("nothing_to_compact"),
  compactError("model_not_configured"),
  compactError("compaction_failed"),
]);
export type CompactThreadError = z.infer<typeof compactThreadErrorSchema>;

/** The error body for `code`. */
export const compactThreadError = (code: CompactThreadErrorCode): CompactThreadError =>
  compactThreadErrorSchema.parse({ code, message: COMPACT_THREAD_ERROR_MESSAGES[code] });
