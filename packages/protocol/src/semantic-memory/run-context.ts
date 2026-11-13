import { z } from "zod";
import { utf8ByteLength, uuidSchema } from "../common.js";
import {
  SEMANTIC_MEMORY_POLICY_MAX_BYTES,
  SEMANTIC_MEMORY_POLICY_MAX_ITEMS,
  semanticMemoryActorKindSchema,
  semanticMemoryDateSchema,
  semanticMemoryKindSchema,
  semanticMemoryScopeSchema,
  semanticMemoryStatementSchema,
} from "./fields.js";

/**
 * `run.start.memory.semantic` (KOBE-377; spec SM23, SM24): the semantic memory items the server
 * picked for this run, which kobe-sandbox-agent renders as the "What Kobe knows" block (KOBE-383)
 * above Notes. Additive: absent on an old server, for an agent without
 * {@link CAPABILITY_SEMANTIC_MEMORY}, for an agent version whose memory setting is `notes_only`
 * or `off` (KOBE-646), and for evals and test chats. The server records each item version given
 * in `run_memory_items` / `run_portable_memory_items` / `run_site_memory_items`.
 *
 * Order is stable-first (Chris 2026-11-12, Q6), so the cacheable prefix changes least: every
 * Policy item (always included, never pinned), then pinned items, then the per-message picks (re-picked on every message, SM24).
 * The selector (KOBE-382) decides membership; the schema checks the order and the byte budgets.
 */

/**
 * `hello.capabilities` entry of an agent that renders `run.start.memory.semantic`. It implies
 * `memory`: `semantic` travels only inside `run.start.memory`, which the server sends only to
 * agents listing `memory`, so an agent listing `semantic_memory` alone gets nothing (L11).
 */
export const CAPABILITY_SEMANTIC_MEMORY = "semantic_memory";

/**
 * Most bytes of the rendered "What Kobe knows" block (SM23): block header and footer, each lane's
 * nonce fences and header, and each item's line (bullet, kind, provenance) plus its statement.
 * {@link semanticMemoryRenderedBytes} computes it with the fixed overheads below; the selector
 * (KOBE-382) fills to it and the renderer (KOBE-383) must stay within those overheads, so
 * `omitted_count` stays true. The Policy cap ({@link SEMANTIC_MEMORY_POLICY_MAX_BYTES}) is a store
 * limit over statement bytes.
 */
export const SEMANTIC_MEMORY_BLOCK_MAX_BYTES = 8 * 1024;
/** Block title, untrusted-data notice and the "n more not shown" line. */
export const SEMANTIC_MEMORY_RENDER_BLOCK_OVERHEAD_BYTES = 256;
/** One lane (Policy or a scope): its header and nonce fences, open and close. */
export const SEMANTIC_MEMORY_RENDER_LANE_OVERHEAD_BYTES = 160;
/** One item: bullet, kind, provenance line and separators, besides the statement. */
export const SEMANTIC_MEMORY_RENDER_ITEM_OVERHEAD_BYTES = 96;
/** Most items in one block. */
export const SEMANTIC_MEMORY_RUN_MAX_ITEMS = 100;

/**
 * Where a statement came from, for the model's provenance line: who wrote the version
 * (`actor_kind`), the item's `as_of` date, and the day the version was saved. Never thread
 * links, evidence or authors' names.
 */
export const runSemanticMemoryProvenanceSchema = z.strictObject({
  actor_kind: semanticMemoryActorKindSchema,
  as_of: semanticMemoryDateSchema.nullable(),
  saved_on: semanticMemoryDateSchema,
});

export const runSemanticMemoryItemSchema = z.strictObject({
  id: uuidSchema,
  version: z.number().int().positive(),
  scope: semanticMemoryScopeSchema,
  kind: semanticMemoryKindSchema,
  statement: semanticMemoryStatementSchema,
  policy: z.boolean(),
  pinned: z.boolean(),
  provenance: runSemanticMemoryProvenanceSchema,
});
export type RunSemanticMemoryItem = z.infer<typeof runSemanticMemoryItemSchema>;

/** 0 = Policy, 1 = pinned, 2 = a per-message pick. */
export const semanticMemoryRunRank = (item: { policy: boolean; pinned: boolean }): number =>
  item.policy ? 0 : item.pinned ? 1 : 2;

const bytes = (items: readonly RunSemanticMemoryItem[]) =>
  items.reduce((sum, i) => sum + utf8ByteLength(i.statement), 0);

/** The lane an item renders in: Policy, or its scope. */
export const semanticMemoryRunLane = (item: RunSemanticMemoryItem): string =>
  item.policy ? "policy" : item.scope;

/** Bytes of the rendered block for these items (see {@link SEMANTIC_MEMORY_BLOCK_MAX_BYTES}). */
export function semanticMemoryRenderedBytes(semantic: {
  items: readonly RunSemanticMemoryItem[];
  omitted_count?: number;
}): number {
  const lanes = new Set(semantic.items.map(semanticMemoryRunLane)).size;
  return (
    SEMANTIC_MEMORY_RENDER_BLOCK_OVERHEAD_BYTES +
    lanes * SEMANTIC_MEMORY_RENDER_LANE_OVERHEAD_BYTES +
    semantic.items.length * SEMANTIC_MEMORY_RENDER_ITEM_OVERHEAD_BYTES +
    bytes(semantic.items)
  );
}

export const runSemanticMemorySchema = z
  .strictObject({
    items: z.array(runSemanticMemoryItemSchema).max(SEMANTIC_MEMORY_RUN_MAX_ITEMS),
    /** Eligible items left out to stay within the budgets (the agent may say there are more). */
    omitted_count: z.number().int().nonnegative(),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["items"], message });
    v.items.forEach((item, i) => {
      if (item.policy && item.scope !== "site") issue(`item ${i}: Policy exists only on the Site`);
      if (item.policy && item.pinned) issue(`item ${i}: Policy items are never pinned`);
      if (item.scope === "portable" && item.kind !== "preference")
        issue(`item ${i}: portable items are preferences`);
      if (item.scope === "portable" && item.provenance.as_of !== null)
        issue(`item ${i}: portable items have no as_of`);
      const prev = v.items[i - 1];
      if (prev && semanticMemoryRunRank(prev) > semanticMemoryRunRank(item))
        issue(`item ${i}: order is Policy, pinned, then per-message picks`);
    });
    if (new Set(v.items.map((i) => `${i.scope}:${i.id}`)).size !== v.items.length)
      issue("an item is listed twice");
    const policy = v.items.filter((i) => i.policy);
    if (policy.length > SEMANTIC_MEMORY_POLICY_MAX_ITEMS) issue("too many Policy items");
    if (bytes(policy) > SEMANTIC_MEMORY_POLICY_MAX_BYTES) issue("Policy exceeds its byte budget");
    if (semanticMemoryRenderedBytes(v) > SEMANTIC_MEMORY_BLOCK_MAX_BYTES)
      issue("rendered block exceeds its byte budget");
  });
export type RunSemanticMemory = z.infer<typeof runSemanticMemorySchema>;
