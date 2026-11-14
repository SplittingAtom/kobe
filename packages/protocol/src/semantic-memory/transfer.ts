import { z } from "zod";
import { timestampSchema, utf8ByteLength, uuidSchema } from "../common.js";
import { semanticMemoryIssueSchema } from "./errors.js";
import {
  SEMANTIC_MEMORY_SCOPE_MAX_ITEMS,
  semanticMemoryDateSchema,
  semanticMemoryKindSchema,
  semanticMemoryScopeSchema,
  semanticMemoryStatementSchema,
  semanticMemoryStatusSchema,
  semanticMemoryTagsSchema,
} from "./fields.js";
import { queryBooleanSchema, semanticMemoryOverridesSchema } from "./items.js";

/**
 * Import and export (KOBE-377; SM21). Formats JSON and CSV carry the same columns, status and
 * supersession included, so an export re-imports as it was.
 *
 * - `POST /v1/memory/semantic/import/preview` body {@link semanticMemoryImportPreviewRequestSchema}
 * - `POST /v1/memory/semantic/import/commit` body {@link semanticMemoryImportCommitRequestSchema}
 * - `POST /v1/memory/semantic/export` body {@link semanticMemoryExportQuerySchema} (a POST since
 *   KOBE-385 review L-4: it writes an audit row) -> {@link semanticMemoryExportDocumentSchema}
 *   or CSV ({@link semanticMemoryExportToCsv})
 *
 * Preview is stateless: it runs the deterministic save checks on every row (secret scan, lint,
 * Policy conflict, near-duplicate, scope rules) and stores nothing. No learning-model check (Q10).
 * More than {@link SEMANTIC_MEMORY_IMPORT_MAX_ROWS} rows or {@link SEMANTIC_MEMORY_IMPORT_MAX_BYTES}
 * is refused whole with `memory_import_too_large` (413); an unreadable file with
 * `memory_import_invalid`.
 *
 * Commit sends the same file with the accepted row indexes and is all-or-nothing: the checks run
 * again, and nothing is saved when any accepted row changed (`memory_import_stale`, rows named),
 * the active rows would pass the scope cap (`memory_scope_full` with `capacity`), or Policy rows
 * would pass 25 items / 2 KiB (`memory_policy_budget_full`). Rows keep their `status`; a
 * `superseded` row must be accepted with the row its `superseded_by` names. Every version lands as
 * `actor_kind = 'import'`; refs are file-local (new ids are made).
 */

export const SEMANTIC_MEMORY_TRANSFER_FORMATS = ["json", "csv"] as const;
export const semanticMemoryTransferFormatSchema = z.enum(SEMANTIC_MEMORY_TRANSFER_FORMATS);
export type SemanticMemoryTransferFormat = z.infer<typeof semanticMemoryTransferFormatSchema>;

/** Largest import file (UTF-8 bytes) and most rows (one scope's worth). */
export const SEMANTIC_MEMORY_IMPORT_MAX_BYTES = 1024 * 1024;
export const SEMANTIC_MEMORY_IMPORT_MAX_ROWS = SEMANTIC_MEMORY_SCOPE_MAX_ITEMS;

/**
 * CSV columns, in order, after a header row. `tags` joined by
 * {@link SEMANTIC_MEMORY_CSV_TAG_SEPARATOR}; booleans `true|false`; empty = null. `policy` is
 * `false` outside the Site (`true` there is `invalid_request` on that row).
 */
export const SEMANTIC_MEMORY_CSV_COLUMNS = [
  "ref",
  "kind",
  "statement",
  "tags",
  "pinned",
  "as_of",
  "policy",
  "status",
  "superseded_by",
] as const;
export const SEMANTIC_MEMORY_CSV_TAG_SEPARATOR = ";";
/** `format` of a JSON export, so an import can tell the file is ours. */
export const SEMANTIC_MEMORY_EXPORT_FORMAT = "kobe.memory.v1";

// ----------------------------------------------------------------------------- CSV cells

/**
 * Cells a spreadsheet would run as a formula (CSV injection, M3): the OWASP leads, their
 * full-width forms (some LibreOffice locales evaluate them), and a lead after leading spaces
 * (KOBE-385 review I-2).
 */
const FORMULA_LEAD = /^(?:[\t\r]|[ \u00a0\u3000]*[=+\-@\uff1d\uff0b\uff0d\uff20])/u;

/** Export: prefix `'` to a cell a spreadsheet would read as a formula. */
export const neutraliseCsvCell = (cell: string): string =>
  FORMULA_LEAD.test(cell) ? `'${cell}` : cell;

/** Import: drop the `'` {@link neutraliseCsvCell} added (only before a formula lead). */
export const restoreCsvCell = (cell: string): string =>
  cell.startsWith("'") && FORMULA_LEAD.test(cell.slice(1)) ? cell.slice(1) : cell;

/** RFC 4180 quoting after neutralising. */
const csvCell = (value: string): string => {
  const cell = neutraliseCsvCell(value);
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
};

// ----------------------------------------------------------------------------- export

export const semanticMemoryExportQuerySchema = z.strictObject({
  scope: semanticMemoryScopeSchema,
  format: semanticMemoryTransferFormatSchema.default("json"),
  /** Archived and superseded items too (default: active only). */
  include_inactive: queryBooleanSchema.optional(),
});
export type SemanticMemoryExportQuery = z.infer<typeof semanticMemoryExportQuerySchema>;

/**
 * One exported item: what an import needs. `ref` is the item's id, used only to link
 * `superseded_by` inside the file. No authors, thread links or evidence.
 */
export const semanticMemoryExportItemSchema = z.strictObject({
  ref: uuidSchema,
  kind: semanticMemoryKindSchema,
  statement: semanticMemoryStatementSchema,
  tags: semanticMemoryTagsSchema,
  pinned: z.boolean(),
  as_of: semanticMemoryDateSchema.nullable(),
  policy: z.boolean(),
  status: semanticMemoryStatusSchema,
  superseded_by: uuidSchema.nullable(),
});
export type SemanticMemoryExportItem = z.infer<typeof semanticMemoryExportItemSchema>;

/** A JSON export; also a valid JSON import file. Items are unbounded with `include_inactive`. */
export const semanticMemoryExportDocumentSchema = z
  .strictObject({
    format: z.literal(SEMANTIC_MEMORY_EXPORT_FORMAT),
    scope: semanticMemoryScopeSchema,
    exported_at: timestampSchema,
    include_inactive: z.boolean(),
    items: z.array(semanticMemoryExportItemSchema),
  })
  .superRefine((doc, ctx) => {
    const refs = new Set(doc.items.map((i) => i.ref));
    if (refs.size !== doc.items.length)
      ctx.addIssue({ code: "custom", path: ["items"], message: "a ref is listed twice" });
    doc.items.forEach((item, i) => {
      const bad = (message: string) =>
        ctx.addIssue({ code: "custom", path: ["items", i], message });
      if (!doc.include_inactive && item.status !== "active")
        bad("inactive item in an active export");
      if ((item.status === "superseded") !== (item.superseded_by !== null))
        bad("superseded_by is set exactly on superseded items");
      if (item.superseded_by !== null && !refs.has(item.superseded_by))
        bad("superseded_by names no item in the file");
    });
  });
export type SemanticMemoryExportDocument = z.infer<typeof semanticMemoryExportDocumentSchema>;

/** The CSV form of an export: header row, CRLF line ends, neutralised and quoted cells. */
export function semanticMemoryExportToCsv(doc: SemanticMemoryExportDocument): string {
  const row = (cells: readonly string[]) => `${cells.map(csvCell).join(",")}\r\n`;
  return (
    row(SEMANTIC_MEMORY_CSV_COLUMNS) +
    doc.items
      .map((i) =>
        row([
          i.ref,
          i.kind,
          i.statement,
          i.tags.join(SEMANTIC_MEMORY_CSV_TAG_SEPARATOR),
          String(i.pinned),
          i.as_of ?? "",
          String(i.policy),
          i.status,
          i.superseded_by ?? "",
        ]),
      )
      .join("")
  );
}

// ----------------------------------------------------------------------------- import

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
 * What a row would do: `new` saves as is; `duplicate` matches an active item (saved only if
 * accepted); `warning` needs "save anyway" (lint or Policy conflict, see `issues`); `invalid`
 * does not parse or breaks a scope rule (Policy off the Site, Policy pinned, a portable fact, a
 * dangling `superseded_by`); `blocked` holds a secret and can never be saved.
 */
export const SEMANTIC_MEMORY_IMPORT_ROW_STATUSES = [
  "new",
  "duplicate",
  "warning",
  "invalid",
  "blocked",
] as const;

/**
 * One row as read. An `invalid` row shows what could be read: kind may be null and text is cut to
 * 1,000 characters. A `blocked` row's statement has the secret replaced. Status and supersession
 * of the row are applied on commit (see the module comment).
 */
export const semanticMemoryImportRowSchema = z.strictObject({
  /** 0-based data row (the CSV header is not a row). */
  index: z.number().int().nonnegative(),
  status: z.enum(SEMANTIC_MEMORY_IMPORT_ROW_STATUSES),
  kind: semanticMemoryKindSchema.nullable(),
  statement: z.string().max(1000),
  tags: z.array(z.string().max(100)).max(20),
  pinned: z.boolean(),
  /** The row becomes Policy (Site imports only). */
  policy: z.boolean(),
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

/** All accepted rows were saved (commit is all-or-nothing). */
export const semanticMemoryImportCommitResponseSchema = z
  .strictObject({
    scope: semanticMemoryScopeSchema,
    created: z.number().int().positive(),
    item_ids: z.array(uuidSchema).min(1).max(SEMANTIC_MEMORY_IMPORT_MAX_ROWS),
  })
  .refine((v) => v.item_ids.length === v.created, { message: "one id per created item" });
export type SemanticMemoryImportCommitResponse = z.infer<
  typeof semanticMemoryImportCommitResponseSchema
>;
