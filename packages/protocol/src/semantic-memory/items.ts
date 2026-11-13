import { z } from "zod";
import { NO_CONTROL_CHARS, idSchema, timestampSchema, uuidSchema } from "../common.js";

/**
 * Semantic memory item contract (v1.3, KOBE-377 = SMA2; spec SM3, SM6, SM8, SM18, SM21, SM23).
 * Short typed statements beside file memory (the UI's Notes, memory.ts). Shapes match the KOBE-376
 * schema (`packages/db/src/schema/semantic-memory.ts`) exactly; `services/server` tests the enums
 * and limits against it.
 *
 * Wire scope names stay `user | portable | team | site` (`team` = the Workspace). People read
 * {@link SEMANTIC_MEMORY_SCOPE_LABELS}: "This workspace", "All my workspaces", never "team".
 *
 * REST (implemented by KOBE-378 item store, KOBE-384/385 editors; OpenAPI in services/server):
 * - `GET    /v1/memory/items?scope=` -> {@link semanticMemoryListResponseSchema}
 * - `POST   /v1/memory/items` body {@link createSemanticMemoryItemSchema} -> 201 detail
 * - `GET    /v1/memory/items/{scope}/{id}` -> {@link semanticMemoryItemDetailSchema}
 * - `PATCH  /v1/memory/items/{scope}/{id}` body {@link patchSemanticMemoryItemSchema} -> detail
 * - `POST   /v1/memory/items/{scope}/{id}/archive` -> detail (never deletes; versions stay)
 * - `POST   /v1/memory/items/{scope}/{id}/restore` -> detail (un-archive)
 * - `POST   /v1/memory/items/{scope}/{id}/revert` body {@link revertSemanticMemoryItemSchema}
 *   -> detail (Undo: a new version copying an earlier one)
 * - `POST   /v1/memory/items/{scope}/{id}/pin` body {@link pinSemanticMemoryItemSchema} -> detail
 * Import / export: transfer.ts. Errors: errors.ts.
 */

export const SEMANTIC_MEMORY_SCOPES = ["user", "portable", "team", "site"] as const;
export const semanticMemoryScopeSchema = z.enum(SEMANTIC_MEMORY_SCOPES);
export type SemanticMemoryScope = z.infer<typeof semanticMemoryScopeSchema>;

/** What people read for each wire scope (Chris 2026-11-12, Q1: Workspace wording). */
export const SEMANTIC_MEMORY_SCOPE_LABELS = {
  user: "Me in this workspace",
  portable: "All my workspaces",
  team: "This workspace",
  site: "Site",
} as const satisfies Record<SemanticMemoryScope, string>;

export const SEMANTIC_MEMORY_KINDS = [
  "preference",
  "fact",
  "convention",
  "definition",
  "decision",
] as const;
export const semanticMemoryKindSchema = z.enum(SEMANTIC_MEMORY_KINDS);
export type SemanticMemoryKind = z.infer<typeof semanticMemoryKindSchema>;

export const SEMANTIC_MEMORY_STATUSES = ["active", "archived", "superseded"] as const;
export const semanticMemoryStatusSchema = z.enum(SEMANTIC_MEMORY_STATUSES);
export type SemanticMemoryStatus = z.infer<typeof semanticMemoryStatusSchema>;

/**
 * Who wrote a version: a person, an import, a person accepting a learning pass's candidate
 * (`pass`, Workspace and portable), or an accepted Site proposal (`proposal`, Site only).
 */
export const SEMANTIC_MEMORY_ACTOR_KINDS = ["user", "import", "pass", "proposal"] as const;
export const semanticMemoryActorKindSchema = z.enum(SEMANTIC_MEMORY_ACTOR_KINDS);
export type SemanticMemoryActorKind = z.infer<typeof semanticMemoryActorKindSchema>;

// ----------------------------------------------------------------------------- limits

/** Longest statement, in characters (SM3; the DB check counts `char_length`). */
export const SEMANTIC_MEMORY_STATEMENT_MAX = 500;
export const SEMANTIC_MEMORY_TAGS_MAX = 5;
export const SEMANTIC_MEMORY_TAG_MAX = 40;
/** Most thread entries one version cites. */
export const SEMANTIC_MEMORY_SOURCE_ENTRIES_MAX = 50;
/** Most active items per scope (per person for user/portable, per Workspace, per Site; SM21). */
export const SEMANTIC_MEMORY_SCOPE_MAX_ITEMS = 1000;
/** Policy (SM23): at most 25 items and 2 KiB of statements, always in context. */
export const SEMANTIC_MEMORY_POLICY_MAX_ITEMS = 25;
export const SEMANTIC_MEMORY_POLICY_MAX_BYTES = 2 * 1024;
/** Curators are told when a shared scope reaches this share of its cap (SM22, KOBE-645). */
export const SEMANTIC_MEMORY_NEAR_FULL_RATIO = 0.8;

export const SEMANTIC_MEMORY_PAGE_MAX = 100;
export const SEMANTIC_MEMORY_PAGE_DEFAULT = 50;
export const SEMANTIC_MEMORY_QUERY_MAX = 200;

// ----------------------------------------------------------------------------- field schemas

/** 1..500 characters, not blank. */
export const semanticMemoryStatementSchema = z
  .string()
  .max(SEMANTIC_MEMORY_STATEMENT_MAX)
  .refine((s) => s.trim().length > 0, { message: "statement is blank" });

/** 1..40 characters, no control characters (the DB check's rule). */
export const semanticMemoryTagSchema = z
  .string()
  .min(1)
  .max(SEMANTIC_MEMORY_TAG_MAX)
  .regex(NO_CONTROL_CHARS);
export const semanticMemoryTagsSchema = z
  .array(semanticMemoryTagSchema)
  .max(SEMANTIC_MEMORY_TAGS_MAX);

/** A calendar date, `YYYY-MM-DD` (`as_of`: "as of Oct 2026" on a fact or decision). */
export const semanticMemoryDateSchema = z.iso.date();

const version = z.number().int().positive();
const sourceEntryIds = z.array(idSchema).min(1).max(SEMANTIC_MEMORY_SOURCE_ENTRIES_MAX);

// ----------------------------------------------------------------------------- responses

/**
 * One item as the API returns it. `policy` is true only on Site items; `as_of` is null on
 * portable items (preferences); `owner_user_id` is set on `user` and `portable` items;
 * `version` is the current version; `updated_by` that version's author.
 */
const itemObject = z.strictObject({
  id: uuidSchema,
  scope: semanticMemoryScopeSchema,
  kind: semanticMemoryKindSchema,
  status: semanticMemoryStatusSchema,
  statement: semanticMemoryStatementSchema,
  tags: semanticMemoryTagsSchema,
  pinned: z.boolean(),
  policy: z.boolean(),
  as_of: semanticMemoryDateSchema.nullable(),
  owner_user_id: uuidSchema.nullable(),
  superseded_by: uuidSchema.nullable(),
  version,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  updated_by: uuidSchema,
});

/** Policy is always in context, so a Policy item is never pinned (coordinator 2026-11-13). */
const POLICY_NOT_PINNED = {
  message: "Policy items are always in context and can't be pinned",
  path: ["pinned"],
};
const policyNotPinned = (v: { policy?: boolean | undefined; pinned?: boolean | undefined }) =>
  !(v.policy === true && v.pinned === true);

export const semanticMemoryItemSchema = itemObject.refine(policyNotPinned, POLICY_NOT_PINNED);
export type SemanticMemoryItem = z.infer<typeof semanticMemoryItemSchema>;

/**
 * One immutable version. `source_thread_id` / `source_entry_ids` exist on Workspace versions only
 * (null elsewhere, and null after the retention scrub). Evidence quotes are not part of this
 * contract yet (Phase B, KOBE-390).
 */
export const semanticMemoryVersionSchema = z.strictObject({
  version,
  statement: semanticMemoryStatementSchema,
  actor_user_id: uuidSchema,
  actor_kind: semanticMemoryActorKindSchema,
  /** Saved over a lint warning (SM18). */
  lint_override: z.boolean(),
  /** Saved despite contradicting Policy (SM23). */
  policy_override: z.boolean(),
  source_thread_id: uuidSchema.nullable(),
  source_entry_ids: sourceEntryIds.nullable(),
  created_at: timestampSchema,
});
export type SemanticMemoryVersion = z.infer<typeof semanticMemoryVersionSchema>;

/** Item with its history, newest version first. */
export const semanticMemoryItemDetailSchema = itemObject
  .extend({ versions: z.array(semanticMemoryVersionSchema).min(1) })
  .refine(policyNotPinned, POLICY_NOT_PINNED);
export type SemanticMemoryItemDetail = z.infer<typeof semanticMemoryItemDetailSchema>;

/** Query booleans arrive as strings. */
const queryBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((v) => v === "true"),
]);

/** `GET /v1/memory/items`: one scope, newest first; `next_cursor` is opaque. */
export const semanticMemoryListQuerySchema = z.strictObject({
  scope: semanticMemoryScopeSchema,
  status: semanticMemoryStatusSchema.default("active"),
  kind: semanticMemoryKindSchema.optional(),
  pinned: queryBoolean.optional(),
  /** Site only: Policy items, or everything but Policy. */
  policy: queryBoolean.optional(),
  q: z.string().min(1).max(SEMANTIC_MEMORY_QUERY_MAX).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SEMANTIC_MEMORY_PAGE_MAX)
    .default(SEMANTIC_MEMORY_PAGE_DEFAULT),
  cursor: z.string().min(1).max(512).optional(),
});
export type SemanticMemoryListQuery = z.infer<typeof semanticMemoryListQuerySchema>;

/** How full the scope is (active items); Policy counters on the Site scope only. */
export const semanticMemoryUsageSchema = z.strictObject({
  count: z.number().int().nonnegative(),
  max: z.number().int().positive(),
  policy_count: z.number().int().nonnegative().optional(),
  policy_bytes: z.number().int().nonnegative().optional(),
});

export const semanticMemoryListResponseSchema = z.strictObject({
  scope: semanticMemoryScopeSchema,
  items: z.array(semanticMemoryItemSchema).max(SEMANTIC_MEMORY_PAGE_MAX),
  next_cursor: z.string().min(1).max(512).nullable(),
  usage: semanticMemoryUsageSchema,
});
export type SemanticMemoryListResponse = z.infer<typeof semanticMemoryListResponseSchema>;

// ----------------------------------------------------------------------------- requests

/**
 * Save over a warning: `lint` (instruction, personal-data or link warnings, SM18) and
 * `policy_conflict` (contradicts Policy, SM23). Each is audited. A secret is never overridable.
 */
export const semanticMemoryOverridesSchema = z.strictObject({
  lint: z.literal(true).optional(),
  policy_conflict: z.literal(true).optional(),
});
export type SemanticMemoryOverrides = z.infer<typeof semanticMemoryOverridesSchema>;

/** Scope rules the DB enforces, checked at the edge too. */
const scopeRules = <
  T extends {
    scope: SemanticMemoryScope;
    kind: SemanticMemoryKind;
    policy?: boolean | undefined;
    pinned?: boolean | undefined;
    as_of?: string | null | undefined;
    source_thread_id?: string | undefined;
    source_entry_ids?: string[] | undefined;
  },
>(
  v: T,
  ctx: z.RefinementCtx,
) => {
  if (v.policy === true && v.scope !== "site")
    ctx.addIssue({ code: "custom", path: ["policy"], message: "Policy exists only on the Site" });
  if (!policyNotPinned(v)) ctx.addIssue({ code: "custom", ...POLICY_NOT_PINNED });
  if (v.scope === "portable" && v.kind !== "preference")
    ctx.addIssue({ code: "custom", path: ["kind"], message: "portable items are preferences" });
  if (v.scope === "portable" && v.as_of != null)
    ctx.addIssue({ code: "custom", path: ["as_of"], message: "portable items have no as_of" });
  const linked = v.source_thread_id !== undefined || v.source_entry_ids !== undefined;
  if (linked && v.scope !== "user" && v.scope !== "team")
    ctx.addIssue({
      code: "custom",
      path: ["source_thread_id"],
      message: "thread links stay in the Workspace",
    });
  if (v.source_entry_ids !== undefined && v.source_thread_id === undefined)
    ctx.addIssue({ code: "custom", path: ["source_entry_ids"], message: "entries need a thread" });
};

/**
 * `POST /v1/memory/items`. `supersedes_id`: an active item of the same scope this one replaces
 * (it becomes `superseded`). Source links name the conversation it came from (Workspace scopes).
 */
export const createSemanticMemoryItemSchema = z
  .strictObject({
    scope: semanticMemoryScopeSchema,
    kind: semanticMemoryKindSchema,
    statement: semanticMemoryStatementSchema,
    tags: semanticMemoryTagsSchema.optional(),
    pinned: z.boolean().optional(),
    policy: z.boolean().optional(),
    as_of: semanticMemoryDateSchema.optional(),
    supersedes_id: uuidSchema.optional(),
    source_thread_id: uuidSchema.optional(),
    source_entry_ids: sourceEntryIds.optional(),
    overrides: semanticMemoryOverridesSchema.optional(),
  })
  .superRefine(scopeRules);
export type CreateSemanticMemoryItem = z.infer<typeof createSemanticMemoryItemSchema>;

/**
 * `PATCH /v1/memory/items/{scope}/{id}`: `expected_version` is the version the editor saw (409
 * `memory_version_conflict` when it moved on). A statement change appends a version; kind, tags,
 * `as_of` and `policy` change the item. `as_of: null` clears it. Scope rules are checked by the
 * server against the stored item (the body has no scope).
 */
export const patchSemanticMemoryItemSchema = z
  .strictObject({
    expected_version: version,
    statement: semanticMemoryStatementSchema.optional(),
    kind: semanticMemoryKindSchema.optional(),
    tags: semanticMemoryTagsSchema.optional(),
    as_of: semanticMemoryDateSchema.nullable().optional(),
    policy: z.boolean().optional(),
    overrides: semanticMemoryOverridesSchema.optional(),
  })
  .refine(
    (v) =>
      v.statement !== undefined ||
      v.kind !== undefined ||
      v.tags !== undefined ||
      v.as_of !== undefined ||
      v.policy !== undefined,
    { message: "change at least one field" },
  );
export type PatchSemanticMemoryItem = z.infer<typeof patchSemanticMemoryItemSchema>;

/** Undo: copy `version` into a new version; `expected_version` as for a patch. */
export const revertSemanticMemoryItemSchema = z.strictObject({
  version,
  expected_version: version,
  overrides: semanticMemoryOverridesSchema.optional(),
});
export type RevertSemanticMemoryItem = z.infer<typeof revertSemanticMemoryItemSchema>;

/**
 * Pin or unpin. Pinning a Policy item is refused with `memory_policy_not_pinnable` (Policy is
 * always in context); so is making a pinned item Policy with a patch (unpin it first).
 */
export const pinSemanticMemoryItemSchema = z.strictObject({ pinned: z.boolean() });
export type PinSemanticMemoryItem = z.infer<typeof pinSemanticMemoryItemSchema>;
