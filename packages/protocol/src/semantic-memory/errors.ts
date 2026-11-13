import { z } from "zod";
import { uuidSchema } from "../common.js";

/**
 * Error answers of the semantic memory API and tools (KOBE-377): `{code, message}` like every
 * Kobe error, plus the details a client needs to offer "Save anyway".
 */
export const SEMANTIC_MEMORY_ERROR_CODES = [
  /** The scope holds its maximum of active items (SM21); archive some first. */
  "memory_scope_full",
  /** Contradicts Policy (SM23); `policy_conflicts` names the items. Overridable, audited. */
  "memory_policy_conflict",
  /** The secret scan found a credential (SM18). Never overridable. */
  "memory_secret",
  /** Policy would pass 25 items or 2 KiB (SM23). */
  "memory_policy_budget_full",
  /** Semantic memory is off for this scope (Site, Workspace or agent version switch). */
  "memory_disabled",
  /** No learning model is set or enabled for the Workspace (Q5: never falls back). */
  "memory_learning_model_unavailable",
  /** Lint warnings (instruction, personal data, links; SM18) in `warnings`. Overridable, audited. */
  "memory_lint_warning",
  /** `expected_version` is not the current version any more. */
  "memory_version_conflict",
  /** No such item in a scope the caller can read. */
  "memory_item_not_found",
  /** The caller may read but not change the item (not its owner, a curator or a Site steward). */
  "memory_not_allowed",
  /** Archived or superseded: restore it first (or the target of a supersede is not active). */
  "memory_item_inactive",
  /** The import file could not be read as the named format. */
  "memory_import_invalid",
] as const;
export const semanticMemoryErrorCodeSchema = z.enum(SEMANTIC_MEMORY_ERROR_CODES);
export type SemanticMemoryErrorCode = z.infer<typeof semanticMemoryErrorCodeSchema>;

export const SEMANTIC_MEMORY_ERROR_HTTP_STATUS = {
  memory_scope_full: 409,
  memory_policy_conflict: 409,
  memory_secret: 422,
  memory_policy_budget_full: 409,
  memory_disabled: 409,
  memory_learning_model_unavailable: 409,
  memory_lint_warning: 409,
  memory_version_conflict: 409,
  memory_item_not_found: 404,
  memory_not_allowed: 403,
  memory_item_inactive: 409,
  memory_import_invalid: 400,
} as const satisfies Record<SemanticMemoryErrorCode, number>;

/** One check's finding: a stable code and a sentence for people. Never the matched secret. */
export const semanticMemoryIssueSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().min(1).max(500),
});
export type SemanticMemoryIssue = z.infer<typeof semanticMemoryIssueSchema>;

export const semanticMemoryErrorSchema = z.strictObject({
  code: semanticMemoryErrorCodeSchema,
  message: z.string().min(1).max(2000),
  /** `memory_lint_warning`. */
  warnings: z.array(semanticMemoryIssueSchema).max(20).optional(),
  /** `memory_policy_conflict`: the Policy items it contradicts. */
  policy_conflicts: z
    .array(z.strictObject({ id: uuidSchema, version: z.number().int().positive() }))
    .max(25)
    .optional(),
});
export type SemanticMemoryError = z.infer<typeof semanticMemoryErrorSchema>;
