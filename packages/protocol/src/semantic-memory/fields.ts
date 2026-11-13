import { z } from "zod";
import { NO_CONTROL_CHARS, idSchema } from "../common.js";

/**
 * Semantic memory vocabulary, limits and field schemas (v1.3, KOBE-377 = SMA2; spec SM3, SM6,
 * SM18, SM21, SM23). They match the KOBE-376 schema (`packages/db/src/schema/semantic-memory.ts`);
 * `services/server` tests the enums and limits against it. Wire scope names stay
 * `user | portable | team | site` (`team` = the Workspace); people read
 * {@link SEMANTIC_MEMORY_SCOPE_LABELS}.
 */

export const SEMANTIC_MEMORY_SCOPES = ["user", "portable", "team", "site"] as const;
export const semanticMemoryScopeSchema = z.enum(SEMANTIC_MEMORY_SCOPES);
export type SemanticMemoryScope = z.infer<typeof semanticMemoryScopeSchema>;

/**
 * The one map of what people read for each wire scope (Chris 2026-11-12, Q1: Workspace wording,
 * never "team"; one label per scope, KOBE-384 review H1): every UI that names a scope uses it, in
 * pickers, editor groups and the context viewer's lanes. "Only in this workspace" is the person's
 * own (`user`); the shared one is "Workspace memories" (`team`), so "this workspace" never names
 * both.
 */
export const SEMANTIC_MEMORY_SCOPE_LABELS = {
  user: "Only in this workspace",
  portable: "All my workspaces",
  team: "Workspace memories",
  site: "Site memories",
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

/** Longest statement, in code points (SM3; the DB check counts `char_length`, so do we). */
export const SEMANTIC_MEMORY_STATEMENT_MAX = 500;
/**
 * Longest justification (why a candidate or proposal should be kept) and reviewer note, in code
 * points (SM9; KOBE-379 checks them on every write path that carries them).
 */
export const SEMANTIC_MEMORY_JUSTIFICATION_MAX = 1000;
export const SEMANTIC_MEMORY_NOTE_MAX = 500;
export const SEMANTIC_MEMORY_TAGS_MAX = 5;
export const SEMANTIC_MEMORY_TAG_MAX = 40;
/** Most thread entries one version cites. */
export const SEMANTIC_MEMORY_SOURCE_ENTRIES_MAX = 50;
/** Most active items per scope (per person for user/portable, per Workspace, per Site; SM21). */
export const SEMANTIC_MEMORY_SCOPE_MAX_ITEMS = 1000;
/** Most pinned active items per scope (KOBE-378; per person for user/portable). */
export const SEMANTIC_MEMORY_PINS_MAX = 10;
/** Policy (SM23): at most 25 items and 2 KiB of statements, always in context. */
export const SEMANTIC_MEMORY_POLICY_MAX_ITEMS = 25;
export const SEMANTIC_MEMORY_POLICY_MAX_BYTES = 2 * 1024;
/** Curators are told when a shared scope reaches this share of its cap (SM22, KOBE-645). */
export const SEMANTIC_MEMORY_NEAR_FULL_RATIO = 0.8;

export const SEMANTIC_MEMORY_PAGE_MAX = 100;
export const SEMANTIC_MEMORY_PAGE_DEFAULT = 50;
export const SEMANTIC_MEMORY_QUERY_MAX = 200;

// ----------------------------------------------------------------------------- field schemas

/** Length in code points, as Postgres `char_length` counts (not UTF-16 units). */
export const codePointLength = (s: string): number => [...s].length;

/** Control characters other than a newline (the renderer fences statements; L6). */
// eslint-disable-next-line no-control-regex
const STATEMENT_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/u;

/** 1..500 code points, not blank, no control characters except newlines. */
export const semanticMemoryStatementSchema = z
  .string()
  .refine((s) => codePointLength(s) <= SEMANTIC_MEMORY_STATEMENT_MAX, {
    message: `statement exceeds ${SEMANTIC_MEMORY_STATEMENT_MAX} characters`,
  })
  .refine((s) => s.trim().length > 0, { message: "statement is blank" })
  .refine((s) => !STATEMENT_CONTROL.test(s), { message: "statement has control characters" });

/** 1..40 code points, trimmed, no control characters (stricter than the DB check). */
export const semanticMemoryTagSchema = z
  .string()
  .min(1)
  .regex(NO_CONTROL_CHARS)
  .refine((t) => codePointLength(t) <= SEMANTIC_MEMORY_TAG_MAX, {
    message: `tag exceeds ${SEMANTIC_MEMORY_TAG_MAX} characters`,
  })
  .refine((t) => t.trim() === t, { message: "tag has surrounding spaces" });
export const semanticMemoryTagsSchema = z
  .array(semanticMemoryTagSchema)
  .max(SEMANTIC_MEMORY_TAGS_MAX);

/** A calendar date, `YYYY-MM-DD` (`as_of`: "as of Oct 2026" on a fact or decision). */
export const semanticMemoryDateSchema = z.iso.date();

export const semanticMemoryVersionNumberSchema = z.number().int().positive();
export const semanticMemorySourceEntryIdsSchema = z
  .array(idSchema)
  .min(1)
  .max(SEMANTIC_MEMORY_SOURCE_ENTRIES_MAX);
