import { MODEL_ALIAS_PATTERN } from "@kobe/db";
import { z } from "zod";
import {
  idSchema,
  threadStatusSchema,
  timestampSchema,
  uuidSchema as wireUuidSchema,
} from "@kobe/protocol";

/**
 * Thread API wire schemas (spec §6.1). Keys are snake_case as in §6.1 and `@kobe/protocol`; ids
 * Kobe mints are uuids, Pi entry ids are opaque strings (1–128 chars, no control characters, the
 * `thread_entries.entry_id` check). Request schemas are strict: unknown keys are a 400. Response
 * schemas document the shape for OpenAPI (see `openapi.ts`).
 */

export const THREAD_PAGE_DEFAULT = 30;
export const THREAD_PAGE_MAX = 100;
export const ENTRY_PAGE_DEFAULT = 200;
export const ENTRY_PAGE_MAX = 500;
export const TITLE_MAX = 200;
export const SEARCH_QUERY_MAX = 256;
/** Soft-deleted threads stay restorable this long before the hard purge (D18, KOBE-18). */
export const TRASH_RETENTION_DAYS = 30;

// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/u;

/** A uuid as sent by a client (any case), normalized to the canonical lowercase form. */
export const uuidSchema = z.uuid().transform((s) => s.toLowerCase());
/** Pi entry id (`@kobe/protocol` idSchema: 1–128 chars, no control characters). */
export const entryIdSchema = idSchema;
export const titleSchema = z.string().trim().min(1).max(TITLE_MAX).regex(NO_CONTROL_CHARS);
/** A model catalog alias (KOBE-44): must be enabled for the team when it is chosen. */
export const modelAliasSchema = z.string().max(64).regex(new RegExp(MODEL_ALIAS_PATTERN));

export const createThreadBodySchema = z.strictObject({
  /**
   * Agent to start with (D19): a team agent of the active team, one of the caller's personal
   * agents, or a gallery agent. The thread pins its current published version. Null or absent =
   * the install default agent.
   */
  agent_id: uuidSchema.nullable().optional(),
  /** Project the thread belongs to (D23); private to its author until shared. */
  project_id: uuidSchema.nullable().optional(),
  title: titleSchema.optional(),
  /** The thread's model (KOBE-44, D30): an alias the team enabled; null or absent = team default. */
  model: modelAliasSchema.nullable().optional(),
});
export type CreateThreadBody = z.infer<typeof createThreadBodySchema>;

export const updateThreadBodySchema = z
  .strictObject({
    /** New title; null clears it. */
    title: titleSchema.nullable().optional(),
    /** Share to (or unshare from) the thread's project, read-only for its members (D23). */
    shared_to_project: z.boolean().optional(),
    /**
     * The model for the thread's next runs (KOBE-44): an alias the team enabled, or null for the
     * team's default. Runs already started keep theirs; queued runs use it when they start.
     */
    model: modelAliasSchema.nullable().optional(),
  })
  .refine(
    (b) => b.title !== undefined || b.shared_to_project !== undefined || b.model !== undefined,
    { message: "give title, shared_to_project or model" },
  );
export type UpdateThreadBody = z.infer<typeof updateThreadBodySchema>;

export const setLeafBodySchema = z.strictObject({ entry_id: entryIdSchema });

/**
 * `POST /v1/threads/{id}/agent-version` (D19 one-click switch): pin another published version of
 * the thread's agent; absent = its current version ("v3 available").
 */
export const switchAgentVersionBodySchema = z.strictObject({
  version: z.number().int().min(1).max(2_147_483_647).optional(),
});

const limitParam = (max: number, fallback: number) =>
  z
    .string()
    .regex(/^[1-9][0-9]{0,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max))
    .optional()
    .transform((n) => n ?? fallback);

export const listThreadsQuerySchema = z.strictObject({
  project_id: uuidSchema.optional(),
  /**
   * Full-text search (KOBE-33, `search.ts`): web-search syntax, matched per message and on titles.
   * With `q`, `cursor` is a search cursor and `limit` is capped at 50.
   */
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX).optional(),
  cursor: z.string().max(256).optional(),
  limit: limitParam(THREAD_PAGE_MAX, THREAD_PAGE_DEFAULT),
});
export type ListThreadsQuery = z.infer<typeof listThreadsQuerySchema>;

export const trashQuerySchema = z.strictObject({
  cursor: z.string().max(256).optional(),
  limit: limitParam(THREAD_PAGE_MAX, THREAD_PAGE_DEFAULT),
});

export const entriesQuerySchema = z.strictObject({
  /** Return entries with `seq` greater than this (the previous page's `next_entries_after`). */
  after: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,9})$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(2_147_483_647))
    .optional()
    .transform((n) => n ?? 0),
  limit: limitParam(ENTRY_PAGE_MAX, ENTRY_PAGE_DEFAULT),
});

// --- Responses ----------------------------------------------------------------------------------

const timestamp = timestampSchema;

export const threadSummarySchema = z.object({
  thread_id: wireUuidSchema,
  title: z.string().nullable(),
  status: threadStatusSchema,
  owner_user_id: wireUuidSchema,
  project_id: wireUuidSchema.nullable(),
  agent_id: wireUuidSchema.nullable(),
  agent_version: z.number().int().nullable(),
  shared_to_project: z.boolean(),
  /** The model chosen for the thread (a catalog alias); null = the team's default (KOBE-44). */
  model: z.string().nullable(),
  leaf_entry_id: idSchema.nullable(),
  last_activity_at: timestamp,
  created_at: timestamp,
  /** Set while the thread is in Trash. */
  deleted_at: timestamp.nullable(),
  /** When the Trash purge may remove it (deleted_at + 30 days); null when not in Trash. */
  purge_after: timestamp.nullable(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadEntrySchema = z.object({
  entry_id: idSchema,
  parent_id: idSchema.nullable(),
  seq: z.number().int().positive(),
  /** Pi session entry type (message, compaction, branch_summary, …). */
  type: z.string(),
  /** The Pi entry as stored. Empty when the body was offloaded to object storage. */
  payload: z.record(z.string(), z.unknown()),
  /** True when the body lives in object storage (over 64 KB, D15); fetched separately. */
  payload_offloaded: z.boolean(),
  created_at: timestamp,
});
export type ThreadEntry = z.infer<typeof threadEntrySchema>;

export const threadPageSchema = z.object({
  threads: z.array(threadSummarySchema),
  next_cursor: z.string().nullable(),
});

/** A piece of a search snippet; `highlight` marks a match. Plain text: render it escaped. */
export const snippetSegmentSchema = z.object({ text: z.string(), highlight: z.boolean() });

/** A search hit (`GET /v1/threads?q=`, KOBE-33): the thread plus why it matched. */
export const threadSearchHitSchema = threadSummarySchema.extend({
  /** The best-matching entry (may be on an inactive branch); null for a title-only match. */
  matched_entry_id: idSchema.nullable(),
  /** Excerpt of that entry around the matches; null for a title-only match. */
  snippet: z.array(snippetSegmentSchema).nullable(),
  /** Relevance; hits are ordered by score, then most recent activity. */
  score: z.number(),
});
export type ThreadSearchHit = z.infer<typeof threadSearchHitSchema>;

export const threadSearchPageSchema = z.object({
  threads: z.array(threadSearchHitSchema),
  next_cursor: z.string().nullable(),
});

export const threadDetailSchema = threadSummarySchema.extend({
  /**
   * The newest published version of the pinned agent (D19 "v3 available" when it is greater than
   * `agent_version`); null without an agent or when the agent is no longer available.
   */
  agent_current_version: z.number().int().nullable(),
  entries: z.array(threadEntrySchema),
  /** Pass as `after` to `GET /v1/threads/{id}/entries` for more; null when all were returned. */
  next_entries_after: z.number().int().nullable(),
});

export const entryPageSchema = z.object({
  entries: z.array(threadEntrySchema),
  next_entries_after: z.number().int().nullable(),
});

export const createdThreadSchema = threadSummarySchema;

export const errorSchema = z.object({ code: z.string(), message: z.string() });
