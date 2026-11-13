import { z } from "zod";
import { timestampSchema, utf8ByteLength, uuidSchema } from "../common.js";
import { semanticMemoryIssueSchema } from "./errors.js";
import {
  SEMANTIC_MEMORY_SCOPE_MAX_ITEMS,
  semanticMemoryDateSchema,
  semanticMemoryKindSchema,
  semanticMemoryOverridesSchema,
  semanticMemoryScopeSchema,
  semanticMemoryStatementSchema,
  semanticMemoryStatusSchema,
  semanticMemoryTagsSchema,
} from "./items.js";

/**
 * Import and export (KOBE-377; SM21). Import is two steps and stateless: preview runs the
 * deterministic save checks on every row (secret scan, lint, Policy conflict, near-duplicate) and
 * stores nothing; commit sends the same file with the rows the person accepted, and the server
 * runs the checks again. No learning-model check (Q10: dropped). Imports land as `actor_kind =
 * 'import'` versions.
 *
 * - `POST /v1/memory/import/preview` body {@link semanticMemoryImportPreviewRequestSchema}
 * - `POST /v1/memory/import/commit` body {@link semanticMemoryImportCommitRequestSchema}
 * - `GET  /v1/memory/export?scope=&format=json|csv` -> {@link semanticMemoryExportDocumentSchema}
 *   or CSV with {@link SEMANTIC_MEMORY_CSV_COLUMNS} (a header row first)
 */

export const SEMANTIC_MEMORY_TRANSFER_FORMATS = ["json", "csv"] as const;
export const semanticMemoryTransferFormatSchema = z.enum(SEMANTIC_MEMORY_TRANSFER_FORMATS);
export type SemanticMemoryTransferFormat = z.infer<typeof semanticMemoryTransferFormatSchema>;

/** Largest import file (UTF-8 bytes) and most rows: one scope's worth. */
export const SEMANTIC_MEMORY_IMPORT_MAX_BYTES = 1024 * 1024;
export const SEMANTIC_MEMORY_IMPORT_MAX_ROWS = SEMANTIC_MEMORY_SCOPE_MAX_ITEMS;

/** CSV columns, in order. `tags` joined by {@link SEMANTIC_MEMORY_CSV_TAG_SEPARATOR}; `policy` Site only. */
export const SEMANTIC_MEMORY_CSV_COLUMNS = [
  "kind",
  "statement",
  "tags",
  "pinned",
  "as_of",
  "policy",
] as const;
export const SEMANTIC_MEMORY_CSV_TAG_SEPARATOR = ";";
/** `format` of a JSON export, so an import can tell the file is ours. */
export const SEMANTIC_MEMORY_EXPORT_FORMAT = "kobe.memory.v1";

const importContent = z
  .string()
  .min(1)
  .refine((s) => utf8ByteLength(s) <= SEMANTIC_MEMORY_IMPORT_MAX_BYTES, {
    message: `import exceeds ${SEMANTIC_MEMORY_IMPORT_MAX_BYTES} bytes`,
  });

export const semanticMemoryImportPreviewRequestSchema = z.strictObject({
  scope: semanticMemoryScopeSchema,
  format: semanticMemoryTransferFormatSchema,
  content: importContent,
});
export type SemanticMemoryImportPreviewRequest = z.infer<
  typeof semanticMemoryImportPreviewRequestSchema
>;

/**
 * What a row would do: `new` saves as is; `duplicate` matches an active item (skipped unless
 * accepted); `warning` needs "save anyway" (lint or Policy conflict, see `issues`); `invalid`
 * does not parse; `blocked` holds a secret and can never be saved.
 */
export const SEMANTIC_MEMORY_IMPORT_ROW_STATUSES = [
  "new",
  "duplicate",
  "warning",
  "invalid",
  "blocked",
] as const;

/**
 * One row as read. An `invalid` row shows what could be read: its kind may be null and its text is
 * cut to 1,000 characters. A `blocked` row's statement has the secret replaced.
 */
export const semanticMemoryImportRowSchema = z.strictObject({
  /** 0-based data row (the CSV header is not a row). */
  index: z.number().int().nonnegative(),
  status: z.enum(SEMANTIC_MEMORY_IMPORT_ROW_STATUSES),
  kind: semanticMemoryKindSchema.nullable(),
  statement: z.string().max(1000),
  tags: z.array(z.string().max(100)).max(20),
  pinned: z.boolean(),
  as_of: semanticMemoryDateSchema.nullable(),
  issues: z.array(semanticMemoryIssueSchema).max(20),
});
export type SemanticMemoryImportRow = z.infer<typeof semanticMemoryImportRowSchema>;

export const semanticMemoryImportPreviewResponseSchema = z.strictObject({
  scope: semanticMemoryScopeSchema,
  rows: z.array(semanticMemoryImportRowSchema).max(SEMANTIC_MEMORY_IMPORT_MAX_ROWS),
  counts: z.strictObject(
    Object.fromEntries(
      SEMANTIC_MEMORY_IMPORT_ROW_STATUSES.map((s) => [s, z.number().int().nonnegative()]),
    ) as Record<(typeof SEMANTIC_MEMORY_IMPORT_ROW_STATUSES)[number], z.ZodNumber>,
  ),
});
export type SemanticMemoryImportPreviewResponse = z.infer<
  typeof semanticMemoryImportPreviewResponseSchema
>;

/**
 * Commit the accepted rows (`index` values of the preview). `overrides` applies to every accepted
 * `warning` row (each override is audited per item).
 */
export const semanticMemoryImportCommitRequestSchema = semanticMemoryImportPreviewRequestSchema
  .extend({
    accept: z.array(z.number().int().nonnegative()).min(1).max(SEMANTIC_MEMORY_IMPORT_MAX_ROWS),
    overrides: semanticMemoryOverridesSchema.optional(),
  })
  .refine((v) => new Set(v.accept).size === v.accept.length, {
    message: "accept lists a row twice",
    path: ["accept"],
  });
export type SemanticMemoryImportCommitRequest = z.infer<
  typeof semanticMemoryImportCommitRequestSchema
>;

export const semanticMemoryImportCommitResponseSchema = z.strictObject({
  scope: semanticMemoryScopeSchema,
  created: z.number().int().nonnegative(),
  /** Accepted rows not saved (they turned invalid, blocked or duplicate on the second check). */
  skipped: z.number().int().nonnegative(),
  item_ids: z.array(uuidSchema).max(SEMANTIC_MEMORY_IMPORT_MAX_ROWS),
});
export type SemanticMemoryImportCommitResponse = z.infer<
  typeof semanticMemoryImportCommitResponseSchema
>;

export const semanticMemoryExportQuerySchema = z.strictObject({
  scope: semanticMemoryScopeSchema,
  format: semanticMemoryTransferFormatSchema.default("json"),
  /** Archived and superseded items too (default: active only). */
  include_inactive: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
    .optional(),
});
export type SemanticMemoryExportQuery = z.infer<typeof semanticMemoryExportQuerySchema>;

/** One exported item: what an import needs, nothing else (no ids, authors, links or evidence). */
export const semanticMemoryExportItemSchema = z.strictObject({
  kind: semanticMemoryKindSchema,
  statement: semanticMemoryStatementSchema,
  tags: semanticMemoryTagsSchema,
  pinned: z.boolean(),
  as_of: semanticMemoryDateSchema.nullable(),
  policy: z.boolean(),
  status: semanticMemoryStatusSchema,
});

/** A JSON export; also a valid JSON import file. */
export const semanticMemoryExportDocumentSchema = z.strictObject({
  format: z.literal(SEMANTIC_MEMORY_EXPORT_FORMAT),
  scope: semanticMemoryScopeSchema,
  exported_at: timestampSchema,
  /** Unbounded: archived and superseded items have no cap. */
  items: z.array(semanticMemoryExportItemSchema),
});
export type SemanticMemoryExportDocument = z.infer<typeof semanticMemoryExportDocumentSchema>;
