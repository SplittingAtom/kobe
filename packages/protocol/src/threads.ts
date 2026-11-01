import { z } from "zod";
import { idSchema, timestampSchema, utf8ByteLength, uuidSchema } from "./common.js";

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

// --- Organization and fork provenance (KOBE-215) ---------------------------------------------------

/**
 * Fields a thread summary gains for pin and archive (CE19), the title lock (CE18) and fork
 * provenance (CE16), mirroring the `threads` columns of migration 0095. Absent decodes as
 * null/false, so summaries from servers that don't send them yet still parse; the feature tickets
 * spread `.shape` into the server's `threadSummarySchema`.
 *
 * - `pinned_at`: when the owner pinned it (the Pinned group sorts by it); null = not pinned.
 * - `archived_at`: when it was archived (hidden from the normal groups); null = not archived.
 * - `title_locked`: the owner renamed it, so auto-titling never touches the title again.
 * - `forked_from_thread_id`: the thread it was forked from; null for a thread that is not a
 *   fork, and cleared when the source is purged (the fork itself stays).
 * - `forked_at_entry_id`: the entry the fork was taken at. The fork copies entries with their
 *   ids, so it names an entry of the fork itself too and survives the source's purge: a fork
 *   point without a source thread means "forked from a thread that no longer exists".
 * - `folder_id` (KOBE-532, TF2/TF5): the team folder the thread is filed in; null = not filed
 *   (`Current`). Sent to every reader of the thread, since the folder is the thread's property.
 */
export const threadOrganizationSchema = z.object({
  pinned_at: timestampSchema.nullable().default(null),
  archived_at: timestampSchema.nullable().default(null),
  title_locked: z.boolean().default(false),
  forked_from_thread_id: uuidSchema.nullable().default(null),
  forked_at_entry_id: idSchema.nullable().default(null),
  folder_id: uuidSchema.nullable().default(null),
});
export type ThreadOrganization = z.infer<typeof threadOrganizationSchema>;

// --- Lineage (KOBE-532, TL1, TL9) -----------------------------------------------------------------

/** Most ancestors the lineage walk climbs (TL1); the chain stops there. */
export const LINEAGE_MAX_DEPTH = 20;

/** Most entries in any sibling or fork list of the lineage (TL1), newest activity first. */
export const LINEAGE_MAX_SIBLINGS = 50;

/**
 * A thread in a sibling or fork list: only threads the viewer may read (TL2). `title` null means
 * untitled (the web shows "Untitled conversation"); `deleted_at` set means in the owner's Trash
 * (only the owner sees those). `owner` says whether the viewer owns it.
 */
export const lineageRelativeSchema = z.strictObject({
  thread_id: uuidSchema,
  title: z.string().nullable(),
  deleted_at: timestampSchema.nullable(),
  owner: z.enum(["me", "other"]),
});
export type LineageRelative = z.infer<typeof lineageRelativeSchema>;

const lineageList = z.array(lineageRelativeSchema).max(LINEAGE_MAX_SIBLINGS);

/**
 * Where TL1's "says `more: true` when cut" lives: every capped list has a boolean beside it named
 * after the list, `siblings_more` next to `siblings` (in each ancestor and in `self`) and
 * `forks_more` next to `forks` (top level). True means the server cut the list at
 * {@link LINEAGE_MAX_SIBLINGS}. Absent decodes as false.
 */
const moreFlag = z.boolean().default(false);

/**
 * One generation above the thread, root first (TL1). `siblings`: the readable forks of this
 * ancestor's own parent, newest first, including itself; [] at the root.
 */
export const lineageAncestorSchema = z.strictObject({
  thread_id: uuidSchema,
  title: z.string().nullable(),
  deleted_at: timestampSchema.nullable(),
  siblings: lineageList,
  siblings_more: moreFlag,
});
export type LineageAncestor = z.infer<typeof lineageAncestorSchema>;

/** The thread asked about: its fork point (null when not a fork) and its readable siblings. */
export const lineageSelfSchema = z.strictObject({
  thread_id: uuidSchema,
  title: z.string().nullable(),
  forked_at_entry_id: idSchema.nullable(),
  siblings: lineageList,
  siblings_more: moreFlag,
});
export type LineageSelf = z.infer<typeof lineageSelfSchema>;

/**
 * `GET /v1/threads/{id}/lineage` (TL1). Reveals nothing about a thread the viewer cannot read:
 * a chain reaching one stops there with `root_hidden: true`; a purged ancestor is simply absent.
 * `ancestors` is root first down to the parent ([] for a thread that is not a fork), at most
 * {@link LINEAGE_MAX_DEPTH}; `forks` are the readable forks of the thread, newest first.
 */
export const threadLineageResponseSchema = z.strictObject({
  thread_id: uuidSchema,
  root_hidden: z.boolean(),
  ancestors: z.array(lineageAncestorSchema).max(LINEAGE_MAX_DEPTH),
  self: lineageSelfSchema,
  forks: lineageList,
  forks_more: moreFlag,
});
export type ThreadLineageResponse = z.infer<typeof threadLineageResponseSchema>;

// --- Folders (KOBE-532, TF1-TF5) ------------------------------------------------------------------

/** Longest folder name, in characters after trimming (TF1, TF4). */
export const THREAD_FOLDER_NAME_MAX = 80;

/** Deepest folder chain, counting the folder itself (TF1). */
export const THREAD_FOLDER_MAX_DEPTH = 3;

/** Most folders per team (TF1); `GET /v1/thread-folders` returns them all, unpaged. */
export const THREAD_FOLDERS_MAX = 500;

// Control characters, line/paragraph separators and bidi controls: a name is one line of text.
const FOLDER_NAME_REFUSED_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * A folder name (TF4): plain text, trimmed, 1-80 characters, one line. Uniqueness among siblings
 * (ignoring case) is the server's (`folder_name_taken`).
 */
export const threadFolderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(THREAD_FOLDER_NAME_MAX)
  .refine((s) => !FOLDER_NAME_REFUSED_CHARS.test(s), { message: "name has control characters" });

/** Manual order among siblings (TF1 `position`, a Postgres integer); ties sort by name. */
const folderPositionSchema = z.number().int().min(0).max(2_147_483_647);

/**
 * A team folder (TF1, TF4). Every member sees every folder. `parent_id` null = top level;
 * `created_by` is for the audit trail only (no folder owner). `threads` is the count for the
 * caller: the folder's own live, unarchived threads the caller may read (not its subfolders').
 */
export const threadFolderSchema = z.strictObject({
  id: uuidSchema,
  parent_id: uuidSchema.nullable(),
  name: threadFolderNameSchema,
  position: folderPositionSchema,
  created_by: uuidSchema,
  threads: z.number().int().nonnegative(),
});
export type ThreadFolder = z.infer<typeof threadFolderSchema>;

/** `GET /v1/thread-folders`: every folder of the team, at most {@link THREAD_FOLDERS_MAX}. */
export const threadFoldersResponseSchema = z.strictObject({
  folders: z.array(threadFolderSchema).max(THREAD_FOLDERS_MAX),
});
export type ThreadFoldersResponse = z.infer<typeof threadFoldersResponseSchema>;

/** `POST /v1/thread-folders` (TF4): absent `parent_id` = top level. */
export const createThreadFolderRequestSchema = z.strictObject({
  name: threadFolderNameSchema,
  parent_id: uuidSchema.optional(),
});
export type CreateThreadFolderRequest = z.infer<typeof createThreadFolderRequestSchema>;

/**
 * `PATCH /v1/thread-folders/{id}` (TF4): rename, move (`parent_id: null` = to the top level) or
 * reorder; at least one field.
 */
export const updateThreadFolderRequestSchema = z
  .strictObject({
    name: threadFolderNameSchema.optional(),
    parent_id: uuidSchema.nullable().optional(),
    position: folderPositionSchema.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });
export type UpdateThreadFolderRequest = z.infer<typeof updateThreadFolderRequestSchema>;

/** `POST /v1/threads/{id}/file` (TF3): the folder to file into; null = out of its folder. */
export const fileThreadRequestSchema = z.strictObject({
  folder_id: uuidSchema.nullable(),
});
export type FileThreadRequest = z.infer<typeof fileThreadRequestSchema>;

/**
 * The `folder` query parameter of `GET /v1/threads` and `/pinned` (TF5): a folder id lists that
 * folder's threads the caller may read; `none` lists the caller's own unfiled ones. The server's
 * `listThreadsQuerySchema` adds it as `folder: threadFolderFilterSchema.optional()`.
 */
export const threadFolderFilterSchema = z.union([uuidSchema, z.literal("none")]);
export type ThreadFolderFilter = z.infer<typeof threadFolderFilterSchema>;

/**
 * Error codes of the folder routes and of filing (TF3, TF4), next to the usual
 * `thread_not_found` (404) and `forbidden` (403). `folder_too_deep` also covers a move whose
 * subtree would end up deeper than {@link THREAD_FOLDER_MAX_DEPTH}; `thread_in_trash` and
 * `test_thread` refuse filing as the other organize actions do.
 */
export const THREAD_FOLDER_ERROR_CODES = [
  "folder_not_found",
  "folder_name_taken",
  "folder_too_deep",
  "folder_cycle",
  "folder_limit",
  "thread_in_trash",
  "test_thread",
] as const;
export const threadFolderErrorCodeSchema = z.enum(THREAD_FOLDER_ERROR_CODES);
export type ThreadFolderErrorCode = z.infer<typeof threadFolderErrorCodeSchema>;

export const THREAD_FOLDER_ERROR_HTTP_STATUS = {
  folder_not_found: 404,
  folder_name_taken: 409,
  folder_too_deep: 409,
  folder_cycle: 409,
  folder_limit: 409,
  thread_in_trash: 409,
  test_thread: 409,
} as const satisfies Record<ThreadFolderErrorCode, number>;
