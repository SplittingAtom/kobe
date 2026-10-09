import { z } from "zod";
import { idSchema, timestampSchema, utf8ByteLength, uuidSchema } from "./common.js";

/**
 * File memory contract (KOBE-153 = 56a of KOBE-56, spec D24). Additive: an agent without
 * {@link CAPABILITY_MEMORY} never registers the tools; an old `run.start` has no `memory` field.
 *
 * Scopes: `user` = personal, one store per (user, team); `project` = shared by the project's
 * members. Each scope is a small tree of markdown files with one index, `MEMORY.md`
 * (~{@link MEMORY_INDEX_MAX_LINES} lines).
 *
 * Reaching a run: the server puts the effective indexes in `run.start.memory`
 * ({@link runMemoryContextSchema}); kobe-sandbox-agent appends them to the system prompt of every
 * turn of that run. Topic files are never preloaded: the model reads them with `recall`.
 *
 * Writes: `remember` -> kobe-policy `policy.check` -> kobe-tools `memory.put` (kobe-tools channel,
 * artifacts.ts) -> `memory.put` frame -> server. A `user` write is applied at once and emits
 * `memory.updated`, whose payload is enough for Undo ({@link undoMemoryAction}). A `project` write
 * is held for approval (the answer is `status: "pending_approval"`; the approval is the normal
 * HMAC-signed one over run_id, tool_call_id and canonical input) and applied, with
 * `memory.updated`, only once approved. `recall` is a read (`memory.read`), never needs approval.
 *
 * Switches (D24): booleans {@link memorySettingsSchema} `memory_enabled` and
 * `project_memory_enabled`, kept per team (team admins) and install-wide (install admins). The
 * effective value is the AND of both levels (`project_memory_enabled` also needs `memory_enabled`).
 * Disabled: the scope is absent from `run.start.memory.scopes`, its index is not sent, and the
 * server answers `memory.put` / `memory.read` for it with error `memory_disabled`.
 */

/** `hello.capabilities` entry of an agent that registers `remember` / `recall`. */
export const CAPABILITY_MEMORY = "memory";

export const MEMORY_SCOPES = ["user", "project"] as const;
export const memoryScopeSchema = z.enum(MEMORY_SCOPES);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const MEMORY_INDEX_FILE = "MEMORY.md";
/** The index is always loaded, so it is bounded; topic files only by {@link MEMORY_FILE_MAX_BYTES}. */
export const MEMORY_INDEX_MAX_LINES = 200;
/** Cap (UTF-8 bytes) of any one memory file, index included. */
export const MEMORY_FILE_MAX_BYTES = 64 * 1024;
export const MEMORY_PATH_MAX = 200;
export const MEMORY_PATH_MAX_DEPTH = 4;
export const MEMORY_QUERY_MAX = 500;
/** Most files a `recall` answer lists. */
export const MEMORY_RECALL_MAX_FILES = 20;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Relative, `/`-separated, 1-4 segments of `[A-Za-z0-9._-]` not starting with a dot, no `..`
 * anywhere, ends in `.md`, at most 200 chars. No traversal is possible by construction.
 */
export const memoryPathSchema = z
  .string()
  .max(MEMORY_PATH_MAX)
  .refine(
    (p) => {
      if (!p.endsWith(".md")) return false;
      const parts = p.split("/");
      return (
        parts.length <= MEMORY_PATH_MAX_DEPTH &&
        parts.every((s) => SEGMENT.test(s) && !s.includes("..")) &&
        p.length > ".md".length
      );
    },
    { message: "invalid memory path" },
  );

const lineCount = (s: string): number => (s === "" ? 0 : s.split("\n").length);

const memoryContent = z.string().refine((s) => utf8ByteLength(s) <= MEMORY_FILE_MAX_BYTES, {
  message: `content exceeds ${MEMORY_FILE_MAX_BYTES} bytes`,
});

export const MEMORY_WRITE_MODES = ["replace", "append"] as const;
export const memoryWriteModeSchema = z.enum(MEMORY_WRITE_MODES);
export type MemoryWriteMode = z.infer<typeof memoryWriteModeSchema>;

/**
 * Tool inputs. `mode` defaults to `replace` when absent. For `append` on `MEMORY.md` the server
 * checks the resulting line count (the schema can only check what it is given).
 */
export const rememberInputSchema = z
  .strictObject({
    scope: memoryScopeSchema,
    path: memoryPathSchema,
    content: memoryContent,
    mode: memoryWriteModeSchema.optional(),
  })
  .refine((v) => v.path !== MEMORY_INDEX_FILE || lineCount(v.content) <= MEMORY_INDEX_MAX_LINES, {
    message: `${MEMORY_INDEX_FILE} exceeds ${MEMORY_INDEX_MAX_LINES} lines`,
    path: ["content"],
  });
export type RememberInput = z.infer<typeof rememberInputSchema>;

/**
 * `{ scope, path }` reads one file; `{ query, scope? }` searches (index lines and topic files,
 * case-insensitive substring); `{ scope? }` or `{}` lists the file paths.
 */
export const recallInputSchema = z
  .strictObject({
    scope: memoryScopeSchema.optional(),
    path: memoryPathSchema.optional(),
    query: z.string().min(1).max(MEMORY_QUERY_MAX).optional(),
  })
  .refine((v) => v.path === undefined || v.scope !== undefined, {
    message: "path needs scope",
    path: ["scope"],
  })
  .refine((v) => v.path === undefined || v.query === undefined, {
    message: "give path or query, not both",
    path: ["query"],
  });
export type RecallInput = z.infer<typeof recallInputSchema>;

export const MEMORY_TOOLS = ["remember", "recall"] as const;
export type MemoryToolName = (typeof MEMORY_TOOLS)[number];
export const memoryToolInputSchema = {
  remember: rememberInputSchema,
  recall: recallInputSchema,
} as const;

// ----------------------------------------------------------------------------- results

/** Open on the sandbox side. Known: {@link MEMORY_ERROR_CODES}. */
export const MEMORY_ERROR_CODES = [
  "memory_disabled",
  "not_allowed",
  "not_found",
  "invalid_input",
  "too_large",
  "index_full",
  "storage_failed",
] as const;
const errorCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const memoryErrorSchema = z.strictObject({ code: errorCode, message: z.string().max(2000) });
export type MemoryError = z.infer<typeof memoryErrorSchema>;

/** `applied` = stored (user scope); `pending_approval` = held until approved (project scope). */
export const memoryPutOkFields = {
  ok: z.literal(true),
  op: z.literal("put"),
  status: z.enum(["applied", "pending_approval"]),
  scope: memoryScopeSchema,
  path: memoryPathSchema,
  version: z.number().int().positive().optional(),
  previous_version: z.number().int().positive().optional(),
} as const;

export const memoryReadFileSchema = z.strictObject({
  scope: memoryScopeSchema,
  path: memoryPathSchema,
  /** Absent in a listing. */
  content: z.string().optional(),
  version: z.number().int().positive(),
});
export const memoryReadOkFields = {
  ok: z.literal(true),
  op: z.literal("read"),
  files: z.array(memoryReadFileSchema).max(MEMORY_RECALL_MAX_FILES),
  /** More matches than {@link MEMORY_RECALL_MAX_FILES}. */
  truncated: z.boolean(),
} as const;
export const memoryFailFields = { ok: z.literal(false), error: memoryErrorSchema } as const;

// ----------------------------------------------------------------------------- kobe-tools channel

/** Requests on the kobe-tools channel (KOBE_TOOLS_FD); dispatch on `op`. */
export const memoryToolsRequestSchema = z.union([
  z.strictObject({
    id: idSchema,
    op: z.literal("memory.put"),
    tool_call_id: idSchema,
    input: rememberInputSchema,
  }),
  z.strictObject({ id: idSchema, op: z.literal("memory.read"), input: recallInputSchema }),
]);
export type MemoryToolsRequest = z.infer<typeof memoryToolsRequestSchema>;

export const memoryToolsResponseSchema = z.union([
  z.strictObject({ id: idSchema, ...memoryPutOkFields }),
  z.strictObject({ id: idSchema, ...memoryReadOkFields }),
  z.strictObject({ id: idSchema, ...memoryFailFields }),
]);
export type MemoryToolsResponse = z.infer<typeof memoryToolsResponseSchema>;

// ----------------------------------------------------------------------------- run.start context

export const memoryIndexSchema = z.strictObject({
  scope: memoryScopeSchema,
  /** `MEMORY.md` as stored, cut to {@link MEMORY_INDEX_MAX_LINES} lines; empty when none yet. */
  content: z.string().refine((s) => utf8ByteLength(s) <= MEMORY_FILE_MAX_BYTES),
  /** 0 = no index yet. */
  version: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type MemoryIndex = z.infer<typeof memoryIndexSchema>;

/**
 * `run.start.memory`: absent = memory unknown to the server (old server) or off. `scopes` = the
 * scopes enabled for this run (tools of a scope not listed are refused); `indexes` has at most one
 * entry per enabled scope. Sent only to agents whose hello lists {@link CAPABILITY_MEMORY}.
 */
export const runMemoryContextSchema = z.strictObject({
  scopes: z.array(memoryScopeSchema).max(MEMORY_SCOPES.length),
  indexes: z.array(memoryIndexSchema).max(MEMORY_SCOPES.length),
});
export type RunMemoryContext = z.infer<typeof runMemoryContextSchema>;

// ----------------------------------------------------------------------------- Undo

/**
 * What the Undo button does for a `memory.updated` event: restore `previous_version` (a new
 * version with the old content, history is kept), or delete the doc when the write created it.
 * `memory.updated` carries everything needed (doc id, scope, path, previous_version).
 */
export function undoMemoryAction(e: {
  version: number;
  previous_version?: number | undefined;
}): { action: "restore"; version: number } | { action: "delete" } {
  return e.previous_version === undefined
    ? { action: "delete" }
    : { action: "restore", version: e.previous_version };
}

// ----------------------------------------------------------------------------- REST (/v1/memory)

/**
 * Panel API; `scope=user|project` plus, for `project`, `project_id` as query. Personal memory
 * is always the caller's own (user, team).
 * - `GET    /v1/memory?scope=` -> {@link memoryListResponseSchema}
 * - `GET    /v1/memory/:id` -> {@link memoryDocDetailSchema}
 * - `PUT    /v1/memory` body {@link memoryPutRequestSchema} -> detail (panel edits apply at once,
 *   also for `project`: a human edit is not an agent write)
 * - `DELETE /v1/memory/:id` -> 204
 * - `POST   /v1/memory/:id/restore` body {@link memoryRestoreRequestSchema} -> detail (Undo)
 * - `GET/PUT /v1/memory/settings?level=team|install` -> {@link memorySettingsSchema}
 */
export const memoryDocSummarySchema = z.strictObject({
  id: uuidSchema,
  scope: memoryScopeSchema,
  path: memoryPathSchema,
  current_version: z.number().int().positive(),
  size_bytes: z.number().int().nonnegative(),
  updated_at: timestampSchema,
  updated_by: uuidSchema.nullable(),
});
export type MemoryDocSummary = z.infer<typeof memoryDocSummarySchema>;

export const memoryListResponseSchema = z.strictObject({ docs: z.array(memoryDocSummarySchema) });
export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;

export const memoryVersionInfoSchema = z.strictObject({
  version: z.number().int().positive(),
  size_bytes: z.number().int().nonnegative(),
  created_at: timestampSchema,
  source: z.enum(["agent", "panel", "restore", "approval"]),
});
export type MemoryVersionInfo = z.infer<typeof memoryVersionInfoSchema>;

export const memoryDocDetailSchema = memoryDocSummarySchema.extend({
  content: z.string(),
  versions: z.array(memoryVersionInfoSchema),
});
export type MemoryDocDetail = z.infer<typeof memoryDocDetailSchema>;

export const memoryPutRequestSchema = z.strictObject({
  scope: memoryScopeSchema,
  path: memoryPathSchema,
  content: memoryContent,
  /** Optimistic concurrency: refused with 409 when the doc moved on. */
  expected_version: z.number().int().nonnegative().optional(),
});
export type MemoryPutRequest = z.infer<typeof memoryPutRequestSchema>;

export const memoryRestoreRequestSchema = z.strictObject({ version: z.number().int().positive() });
export type MemoryRestoreRequest = z.infer<typeof memoryRestoreRequestSchema>;

/** Both levels use the same shape; absent key = leave unchanged on PUT, default `true` when never set. */
export const memorySettingsSchema = z.strictObject({
  memory_enabled: z.boolean().optional(),
  project_memory_enabled: z.boolean().optional(),
});
export type MemorySettings = z.infer<typeof memorySettingsSchema>;
