import { MODEL_ALIAS_PATTERN } from "@kobe/db";
import { z } from "zod";
import {
  idSchema,
  scheduleThreadMarkerSchema,
  THREAD_TITLE_MAX,
  threadOrganizationSchema,
  threadTitleSchema,
  threadStatusSchema,
  timestampSchema,
  threadVisibilitySchema,
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
export const TITLE_MAX = THREAD_TITLE_MAX;
export const SEARCH_QUERY_MAX = 256;
/** Soft-deleted threads stay restorable this long before the hard purge (D18, KOBE-18). */
export const TRASH_RETENTION_DAYS = 30;

/** A uuid as sent by a client (any case), normalized to the canonical lowercase form. */
export const uuidSchema = z.uuid().transform((s) => s.toLowerCase());
/** Pi entry id (`@kobe/protocol` idSchema: 1–128 chars, no control characters). */
export const entryIdSchema = idSchema;
/** Create, rename and fork share one title rule (`@kobe/protocol`). */
export const titleSchema = threadTitleSchema;
/** A model catalog alias (KOBE-44): must be enabled for the team when it is chosen. */
export const modelAliasSchema = z.string().max(64).regex(new RegExp(MODEL_ALIAS_PATTERN));

export const createThreadBodySchema = z.strictObject({
  /**
   * Agent to start with (D19): a team agent of the active team, one of the caller's personal
   * agents, or a gallery agent. The thread pins its current published version. Null or absent =
   * the site default agent.
   */
  agent_id: uuidSchema.nullable().optional(),
  /** Project the thread belongs to (D23); private to its author until shared. */
  project_id: uuidSchema.nullable().optional(),
  title: titleSchema.optional(),
  /** The thread's model (KOBE-44, D30): an alias the team enabled; null or absent = team default. */
  model: modelAliasSchema.nullable().optional(),
  /**
   * A builder test thread (KOBE-85): chats with the agent's unpublished draft (needs `agent_id`
   * and the right to edit that agent), private to its creator, kept out of lists and search.
   */
  test: z.boolean().optional(),
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

/**
 * `POST /v1/threads/{id}/move` (CE19, KOBE-220): the project to move the thread to, where the
 * caller may start a thread; null = out of its project ("Your threads").
 */
export const moveThreadBodySchema = z.strictObject({ project_id: uuidSchema.nullable() });

/** Trash, and the Pinned and Archived lists (CE19): newest first, keyset pages. */
export const trashQuerySchema = z.strictObject({
  cursor: z.string().max(256).optional(),
  limit: limitParam(THREAD_PAGE_MAX, THREAD_PAGE_DEFAULT),
});

export const clearTestThreadsQuerySchema = z.strictObject({
  /** Only the test threads of this agent; absent = all the caller's test threads. */
  agent_id: uuidSchema.optional(),
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
  /** The share scope (D23, CE20): `private`, `project` or `team` (KOBE-221). */
  visibility: threadVisibilitySchema,
  /**
   * Computed for the caller (KOBE-221): true for a thread someone else shared with them, which
   * they may read and fork, nothing more. Absent where no viewer applies (a just-created thread).
   */
  read_only: z.boolean().optional(),
  /**
   * For a reader: the name of the member who shared it ("Shared by …"), null once they left the
   * team. Always null for the caller's own threads; never an email address.
   */
  owner_name: z.string().nullable().optional(),
  /** A builder test thread (KOBE-85): runs the agent's draft, `agent_version` is null. */
  is_test: z.boolean(),
  /** The model chosen for the thread (a catalog alias); null = the team's default (KOBE-44). */
  model: z.string().nullable(),
  leaf_entry_id: idSchema.nullable(),
  last_activity_at: timestamp,
  created_at: timestamp,
  /** Set while the thread is in Trash. */
  deleted_at: timestamp.nullable(),
  /** When the Trash purge may remove it (deleted_at + 30 days); null when not in Trash. */
  purge_after: timestamp.nullable(),
  /** The schedule that created the thread (the web "Scheduled" folder), null otherwise (KOBE-173). */
  ...scheduleThreadMarkerSchema.shape,
  /**
   * Fork provenance (CE16, KOBE-216). `forked_from_thread_id` names the source only while the
   * viewer may open it (else null, as after the source's purge); `forked_at_entry_id` is an entry
   * of this thread itself (the fork copies entries with their ids). Source null with a fork point
   * means "forked from a thread you can't open".
   */
  ...threadOrganizationSchema.pick({ forked_from_thread_id: true, forked_at_entry_id: true }).shape,
  /** The source's title when the viewer may open it (null: untitled, not a fork, or no access). */
  forked_from_title: z.string().nullable(),
  /**
   * The owner's organization (CE19, KOBE-220): pinned (the Pinned group, by this time) or
   * archived (out of the normal groups, still searchable, retention unchanged); never both.
   */
  ...threadOrganizationSchema.pick({ pinned_at: true, archived_at: true }).shape,
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

/** Longest first message the hover card shows (KOBE-219); the rest is cut. */
export const THREAD_CARD_MESSAGE_CHARS = 280;

/** `GET /v1/threads/{id}/card` (CE18, KOBE-219): the rail's hover card. */
export const threadCardSchema = z.object({
  thread_id: wireUuidSchema,
  /** The thread's first user message, whitespace collapsed, cut to 280 characters; null: none. */
  first_message: z.string().max(THREAD_CARD_MESSAGE_CHARS).nullable(),
  /** True when `first_message` was cut. */
  first_message_truncated: z.boolean(),
  /** The pinned agent; null for the site default agent. */
  agent_id: wireUuidSchema.nullable(),
  /** The pinned agent's name; null for the default agent or one no longer available. */
  agent_name: z.string().nullable(),
  last_activity_at: timestamp,
  /** The member's messages and the agent's answers (tool-only turns not counted), all branches. */
  message_count: z.number().int().min(0),
  /** The count read only the first 1,000 message entries: the thread holds more ("1,000+"). */
  message_count_capped: z.boolean(),
});
export type ThreadCard = z.infer<typeof threadCardSchema>;

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
  /** A tool output over 64 KB cut to a preview (KOBE-208); the full one via `.../output`. */
  payload_truncated: z.literal(true).optional(),
  created_at: timestamp,
});
export type ThreadEntry = z.infer<typeof threadEntrySchema>;

/** `GET /v1/threads/{id}/entries/{entryId}/output` (KOBE-208): a tool result's full output. */
export const toolOutputSchema = z.object({
  entry_id: idSchema,
  tool_call_id: z.string(),
  tool_name: z.string(),
  is_error: z.boolean(),
  text: z.string(),
  /** The output was longer than the route answers (1,000,000 characters). */
  truncated: z.boolean(),
});

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
  /** The pinned agent's name and effective status in this team (KOBE-122); null without one. */
  agent_name: z.string().nullable(),
  /** True for a reader of a shared thread (project or team): no messages, runs or changes (D23). */
  read_only: z.boolean(),
  agent_status: z.enum(["active", "suspended", "archived"]).nullable(),
  agent_current_version: z.number().int().nullable(),
  /**
   * The model alias the thread's agent pins (KOBE-44; resolved by the run's agent resolver,
   * KOBE-47). When set it wins over `model`: runs use it whatever the conversation chose.
   */
  agent_model: z.string().nullable(),
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
