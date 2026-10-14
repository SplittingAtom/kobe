import { z } from "zod";
import { utf8ByteLength, uuidSchema } from "./common.js";

/**
 * Thread compaction (KOBE-212, CE15): `POST /v1/threads/{id}/compact` and the shapes the
 * `thread.compact` wire command (sandbox-wire/frames.ts) shares with it. Pi owns compaction: the
 * sandbox agent maps the command onto Pi 1.0.x RPC `{"type":"compact","customInstructions"?}`
 * (verified against the pinned 1.0.0 tarball, see docs/ledger/KOBE-212.md). Pi appends a
 * `compaction` session entry (summary, firstKeptEntryId, tokensBefore, ...) that the server
 * mirrors like any other entry; Kobe never summarizes server-side.
 *
 * Pi's `compact` aborts whatever the session is doing first, so the server refuses while the
 * thread has an active run (`thread_busy`) and the agent refuses again if it sees one.
 */

/**
 * Hello capability: the agent understands `thread.compact` and answers `thread.compact_result`.
 * The server sends the command only to agents that announced it.
 */
export const CAPABILITY_THREAD_COMPACT = "thread_compact";

/** Longest `focus`, in UTF-16 code units (Pi appends it to its summary prompt). */
export const THREAD_COMPACT_FOCUS_MAX_CHARS = 1000;

/** Longest summary echoed back (UTF-8 bytes); the mirrored `compaction` entry is authoritative. */
export const THREAD_COMPACT_SUMMARY_MAX_BYTES = 256 * 1024;

// C0 controls other than tab, LF and CR, and DEL.
// eslint-disable-next-line no-control-regex
const FOCUS_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

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
  .refine((s) => !FOCUS_CONTROL_CHARS.test(s), { message: "focus has control characters" });

/** Pi's `CompactionResult` in Kobe's casing, shared by the wire reply and the HTTP response. */
export const threadCompactResultShape = {
  /**
   * The summary Pi wrote. Absent when it is over {@link THREAD_COMPACT_SUMMARY_MAX_BYTES} (the
   * compaction still happened; read the mirrored entry).
   */
  summary: z
    .string()
    .refine((s) => utf8ByteLength(s) <= THREAD_COMPACT_SUMMARY_MAX_BYTES, {
      message: `summary is over ${THREAD_COMPACT_SUMMARY_MAX_BYTES} bytes`,
    })
    .optional(),
  /** Pi `firstKeptEntryId`: the first entry still sent to the model after the summary. */
  first_kept_entry_id: z.string().min(1).max(128),
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
  "compaction_failed",
] as const;
export const compactThreadErrorCodeSchema = z.enum(COMPACT_THREAD_ERROR_CODES);
export type CompactThreadErrorCode = z.infer<typeof compactThreadErrorCodeSchema>;

/** `sandbox_unavailable` is retryable; `compaction_failed` is the summary's model call failing. */
export const COMPACT_THREAD_ERROR_HTTP_STATUS = {
  thread_busy: 409,
  sandbox_unavailable: 503,
  nothing_to_compact: 409,
  compaction_failed: 502,
} as const satisfies Record<CompactThreadErrorCode, number>;

export const compactThreadErrorSchema = z.strictObject({
  code: compactThreadErrorCodeSchema,
  message: z.string().max(2000),
});
export type CompactThreadError = z.infer<typeof compactThreadErrorSchema>;
