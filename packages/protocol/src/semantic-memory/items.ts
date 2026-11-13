import { z } from "zod";
import { timestampSchema, uuidSchema } from "../common.js";
import {
  SEMANTIC_MEMORY_PAGE_DEFAULT,
  SEMANTIC_MEMORY_PAGE_MAX,
  SEMANTIC_MEMORY_QUERY_MAX,
  type SemanticMemoryKind,
  type SemanticMemoryScope,
  semanticMemoryActorKindSchema,
  semanticMemoryDateSchema,
  semanticMemoryKindSchema,
  semanticMemoryScopeSchema,
  semanticMemorySourceEntryIdsSchema,
  semanticMemoryStatementSchema,
  semanticMemoryStatusSchema,
  semanticMemoryTagsSchema,
  semanticMemoryVersionNumberSchema as version,
} from "./fields.js";

/**
 * Semantic memory item API (v1.3, KOBE-377 = SMA2; spec SM8, SM18, SM21, SM23). One surface over
 * the Workspace, portable and Site tables (KOBE-376); scope is in the item path because ids live in
 * different tables.
 *
 * Routes live under `/v1/memory/semantic/`, so they never collide with the Notes routes
 * (`/v1/memory/:id`, `/v1/memory/:id/restore`; routes/memory.ts). Implemented by KOBE-378 (items)
 * and KOBE-384/385 (editors, import/export); OpenAPI in services/server.
 * - `GET    /v1/memory/semantic/items?scope=` -> {@link semanticMemoryListResponseSchema}
 * - `POST   /v1/memory/semantic/items` body {@link createSemanticMemoryItemSchema} -> 201 detail
 * - `GET    /v1/memory/semantic/items/{scope}/{id}` -> {@link semanticMemoryItemDetailSchema}
 * - `PATCH  /v1/memory/semantic/items/{scope}/{id}` body {@link patchSemanticMemoryItemSchema}
 * - `POST   /v1/memory/semantic/items/{scope}/{id}/archive` body {@link semanticMemoryItemActionSchema}
 *   (optional; never deletes, versions stay)
 * - `POST   /v1/memory/semantic/items/{scope}/{id}/restore` body {@link semanticMemoryItemActionSchema}
 *   (optional; un-archive)
 * - `POST   /v1/memory/semantic/items/{scope}/{id}/revert` body {@link revertSemanticMemoryItemSchema}
 *   (Undo: a new version copying an earlier one)
 * - `POST   /v1/memory/semantic/items/{scope}/{id}/pin` body {@link pinSemanticMemoryItemSchema}
 * Import / export: transfer.ts. Errors: errors.ts.
 *
 * Walls in responses (M6): portable and Site versions never carry thread links; Workspace
 * (`team`) links are returned only to the item's author and its curators (null for other
 * members); Site items shown in a Workspace carry no author ids (`updated_by` and
 * `actor_user_id` are null except for Site admins and Site stewards).
 */

// ----------------------------------------------------------------------------- responses

const itemShape = {
  id: uuidSchema,
  scope: semanticMemoryScopeSchema,
  kind: semanticMemoryKindSchema,
  status: semanticMemoryStatusSchema,
  statement: semanticMemoryStatementSchema,
  tags: semanticMemoryTagsSchema,
  pinned: z.boolean(),
  policy: z.boolean(),
  as_of: semanticMemoryDateSchema.nullable(),
  /** Set exactly on `user` and `portable` items. */
  owner_user_id: uuidSchema.nullable(),
  /** Set exactly when `status = "superseded"`. */
  superseded_by: uuidSchema.nullable(),
  version,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  /** The current version's author; null only on Site items for readers who may not see it. */
  updated_by: uuidSchema.nullable(),
};

interface ItemRuleFields {
  scope: SemanticMemoryScope;
  kind: SemanticMemoryKind;
  status: string;
  pinned: boolean;
  policy: boolean;
  as_of: string | null;
  owner_user_id: string | null;
  superseded_by: string | null;
  id: string;
  updated_by: string | null;
}

/** The DB's checks and the walls, applied to every item response (L4, M6). */
const itemRules = (v: ItemRuleFields, ctx: z.RefinementCtx) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });
  if (v.policy && v.scope !== "site") issue("policy", "Policy exists only on the Site");
  if (v.policy && v.pinned) issue("pinned", "Policy items are always in context, never pinned");
  const personal = v.scope === "user" || v.scope === "portable";
  if (personal !== (v.owner_user_id !== null))
    issue("owner_user_id", "set exactly on user and portable items");
  if (v.scope === "portable" && v.kind !== "preference")
    issue("kind", "portable items are preferences");
  if (v.scope === "portable" && v.as_of !== null) issue("as_of", "portable items have no as_of");
  if ((v.status === "superseded") !== (v.superseded_by !== null) || v.superseded_by === v.id)
    issue("superseded_by", "set exactly on superseded items, never to the item itself");
  if (v.scope !== "site" && v.updated_by === null)
    issue("updated_by", "author ids are withheld only on Site items");
};

/** One item as the API returns it; `version` is the current version. */
export const semanticMemoryItemSchema = z.strictObject(itemShape).superRefine(itemRules);
export type SemanticMemoryItem = z.infer<typeof semanticMemoryItemSchema>;

/**
 * One immutable version. Thread links on Workspace versions only, and only for the author and
 * curators (null after the retention scrub too). Evidence quotes are not part of this contract yet
 * (Phase B, KOBE-390).
 */
export const semanticMemoryVersionSchema = z.strictObject({
  version,
  statement: semanticMemoryStatementSchema,
  /** Null only on Site items for readers who may not see authors. */
  actor_user_id: uuidSchema.nullable(),
  actor_kind: semanticMemoryActorKindSchema,
  /** Saved over a lint warning (SM18). */
  lint_override: z.boolean(),
  /** Saved despite contradicting Policy (SM23). */
  policy_override: z.boolean(),
  source_thread_id: uuidSchema.nullable(),
  source_entry_ids: semanticMemorySourceEntryIdsSchema.nullable(),
  created_at: timestampSchema,
});
export type SemanticMemoryVersion = z.infer<typeof semanticMemoryVersionSchema>;

/** Item with its history, newest version first. */
export const semanticMemoryItemDetailSchema = z
  .strictObject({ ...itemShape, versions: z.array(semanticMemoryVersionSchema).min(1) })
  .superRefine((v, ctx) => {
    itemRules(v, ctx);
    v.versions.forEach((ver, i) => {
      const linked = ver.source_thread_id !== null || ver.source_entry_ids !== null;
      if (linked && v.scope !== "user" && v.scope !== "team")
        ctx.addIssue({
          code: "custom",
          path: ["versions", i, "source_thread_id"],
          message: "thread links stay in the Workspace",
        });
      if (ver.source_entry_ids !== null && ver.source_thread_id === null)
        ctx.addIssue({
          code: "custom",
          path: ["versions", i, "source_entry_ids"],
          message: "entries need a thread",
        });
      if (v.scope !== "site" && ver.actor_user_id === null)
        ctx.addIssue({
          code: "custom",
          path: ["versions", i, "actor_user_id"],
          message: "author ids are withheld only on Site items",
        });
    });
  });
export type SemanticMemoryItemDetail = z.infer<typeof semanticMemoryItemDetailSchema>;

/** Query booleans arrive as strings. */
export const queryBooleanSchema = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((v) => v === "true"),
]);

/**
 * `GET /v1/memory/semantic/items`: one scope, newest first; `next_cursor` is opaque. `policy` on
 * a scope other than `site` is `invalid_request`.
 */
export const semanticMemoryListQuerySchema = z.strictObject({
  scope: semanticMemoryScopeSchema,
  status: semanticMemoryStatusSchema.default("active"),
  kind: semanticMemoryKindSchema.optional(),
  pinned: queryBooleanSchema.optional(),
  policy: queryBooleanSchema.optional(),
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

export const semanticMemoryListResponseSchema = z
  .strictObject({
    scope: semanticMemoryScopeSchema,
    items: z.array(semanticMemoryItemSchema).max(SEMANTIC_MEMORY_PAGE_MAX),
    next_cursor: z.string().min(1).max(512).nullable(),
    usage: semanticMemoryUsageSchema,
  })
  .refine((v) => v.items.every((i) => i.scope === v.scope), {
    message: "every item is of the listed scope",
    path: ["items"],
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
const createRules = (
  v: {
    scope: SemanticMemoryScope;
    kind: SemanticMemoryKind;
    policy?: boolean | undefined;
    pinned?: boolean | undefined;
    as_of?: string | undefined;
    source_thread_id?: string | undefined;
    source_entry_ids?: string[] | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });
  if (v.policy === true && v.scope !== "site") issue("policy", "Policy exists only on the Site");
  if (v.policy === true && v.pinned === true)
    issue("pinned", "Policy items are always in context, never pinned");
  if (v.scope === "portable" && v.kind !== "preference")
    issue("kind", "portable items are preferences");
  if (v.scope === "portable" && v.as_of !== undefined)
    issue("as_of", "portable items have no as_of");
  const linked = v.source_thread_id !== undefined || v.source_entry_ids !== undefined;
  if (linked && v.scope !== "user" && v.scope !== "team")
    issue("source_thread_id", "thread links stay in the Workspace");
  if (v.source_entry_ids !== undefined && v.source_thread_id === undefined)
    issue("source_entry_ids", "entries need a thread");
};

/**
 * `POST /v1/memory/semantic/items`. `supersedes_id`: an active item of the same scope this one
 * replaces (it becomes `superseded`). Source links name the conversation (Workspace scopes only).
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
    source_entry_ids: semanticMemorySourceEntryIdsSchema.optional(),
    overrides: semanticMemoryOverridesSchema.optional(),
  })
  .superRefine(createRules);
export type CreateSemanticMemoryItem = z.infer<typeof createSemanticMemoryItemSchema>;

/**
 * `PATCH /v1/memory/semantic/items/{scope}/{id}`: `expected_version` is the version the editor
 * saw (409 `memory_version_conflict` when it moved on). A statement change appends a version;
 * kind, tags, `as_of` and `policy` change the item; `as_of: null` clears it. The body has no
 * scope, so the server checks the stored item: `kind` other than preference or any `as_of` on a
 * portable item, or `policy` off the Site, is `invalid_request`; `policy: true` on a pinned item
 * is `memory_policy_not_pinnable`.
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
 * Optimistic concurrency for archive, restore and pin (same pattern as a patch): when
 * `expected_version` is sent and the item moved on, 409 `memory_version_conflict`. Absent = no
 * check. Archive and restore take this as their (optional) body.
 */
export const semanticMemoryItemActionSchema = z.strictObject({
  expected_version: version.optional(),
});
export type SemanticMemoryItemAction = z.infer<typeof semanticMemoryItemActionSchema>;

/**
 * Pin or unpin. Pinning a Policy item is refused with `memory_policy_not_pinnable` (Policy is
 * always in context).
 */
export const pinSemanticMemoryItemSchema = z.strictObject({
  pinned: z.boolean(),
  expected_version: version.optional(),
});
export type PinSemanticMemoryItem = z.infer<typeof pinSemanticMemoryItemSchema>;
