import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AGENT_MEMORY_SETTINGS,
  CAPABILITY_SEMANTIC_MEMORY,
  CONTEXT_MEMORY_LANES,
  CONTEXT_MEMORY_SECTION_LABELS,
  MEMORY_NOTIFICATION_KINDS,
  MEMORY_STEWARD_SITE_GRANT,
  NOTIFICATION_KINDS,
  RESERVED_MEMORY_AUDIT_ACTIONS,
  SEMANTIC_MEMORY_BLOCK_MAX_BYTES,
  SEMANTIC_MEMORY_CSV_COLUMNS,
  SEMANTIC_MEMORY_ERROR_CODES,
  SEMANTIC_MEMORY_ERROR_HTTP_STATUS,
  SEMANTIC_MEMORY_POLICY_MAX_BYTES,
  SEMANTIC_MEMORY_SCOPE_LABELS,
  SEMANTIC_MEMORY_SCOPES,
  SEMANTIC_MEMORY_STATEMENT_MAX,
  agentVersionMemoryFieldSchema,
  createSemanticMemoryItemSchema,
  decodeServerFrame,
  memoryStewardListSchema,
  patchSemanticMemoryItemSchema,
  pinSemanticMemoryItemSchema,
  revertSemanticMemoryItemSchema,
  runMemoryContextSchema,
  runSemanticMemorySchema,
  runStartFrameSchema,
  semanticMemoryErrorSchema,
  semanticMemoryExportDocumentSchema,
  semanticMemoryExportQuerySchema,
  semanticMemoryImportCommitRequestSchema,
  semanticMemoryImportCommitResponseSchema,
  semanticMemoryImportPreviewRequestSchema,
  semanticMemoryImportPreviewResponseSchema,
  semanticMemoryItemDetailSchema,
  semanticMemoryListQuerySchema,
  semanticMemoryListResponseSchema,
} from "../index.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;

/** Golden fixtures (ac-1): each file parses with its schema and round-trips unchanged. */
const GOLDEN: [string, z.ZodType][] = [
  ["run-start-semantic", runStartFrameSchema],
  ["item-detail", semanticMemoryItemDetailSchema],
  ["list-response", semanticMemoryListResponseSchema],
  ["create-request", createSemanticMemoryItemSchema],
  ["create-portable-request", createSemanticMemoryItemSchema],
  ["patch-request", patchSemanticMemoryItemSchema],
  ["revert-request", revertSemanticMemoryItemSchema],
  ["pin-request", pinSemanticMemoryItemSchema],
  ["import-preview-request", semanticMemoryImportPreviewRequestSchema],
  ["import-preview-response", semanticMemoryImportPreviewResponseSchema],
  ["import-commit-request", semanticMemoryImportCommitRequestSchema],
  ["import-commit-response", semanticMemoryImportCommitResponseSchema],
  ["export-document", semanticMemoryExportDocumentSchema],
  ["error-policy-conflict", semanticMemoryErrorSchema],
  ["error-lint", semanticMemoryErrorSchema],
  ["stewards", memoryStewardListSchema],
  ["agent-version-memory", agentVersionMemoryFieldSchema],
  ["item-detail-portable", semanticMemoryItemDetailSchema],
  ["item-detail-site", semanticMemoryItemDetailSchema],
  ["create-boundary-request", createSemanticMemoryItemSchema],
  ["error-secret", semanticMemoryErrorSchema],
  ["error-scope-full", semanticMemoryErrorSchema],
  ["error-version-conflict", semanticMemoryErrorSchema],
  ["error-policy-not-pinnable", semanticMemoryErrorSchema],
  ["error-import-invalid", semanticMemoryErrorSchema],
  ["error-import-too-large", semanticMemoryErrorSchema],
  ["error-import-stale", semanticMemoryErrorSchema],
  ["error-near-duplicate", semanticMemoryErrorSchema],
  ["error-pin-limit", semanticMemoryErrorSchema],
];

describe("semantic memory golden fixtures (ac-1)", () => {
  it.each(GOLDEN)("%s", (name, schema) => {
    const value = fixture(name);
    const parsed = schema.safeParse(value);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data).toEqual(value);
  });

  it("run.start with memory.semantic decodes as a server frame", () => {
    expect(decodeServerFrame(JSON.stringify(fixture("run-start-semantic"))).ok).toBe(true);
  });
});

describe("run.start.memory.semantic is additive (ac-2)", () => {
  it("an old run.start without semantic still validates", () => {
    const legacy = fixture("run-start-legacy");
    expect(runStartFrameSchema.safeParse(legacy).success).toBe(true);
    expect(decodeServerFrame(JSON.stringify(legacy)).ok).toBe(true);
    expect(runMemoryContextSchema.safeParse(legacy.memory).success).toBe(true);
  });

  it("semantic-only memory (Notes off by the agent setting) validates", () => {
    const semantic = (fixture("run-start-semantic").memory as { semantic: unknown }).semantic;
    expect(runMemoryContextSchema.safeParse({ scopes: [], indexes: [], semantic }).success).toBe(
      true,
    );
  });

  it("names the agent capability that receives it", () => {
    expect(CAPABILITY_SEMANTIC_MEMORY).toBe("semantic_memory");
  });
});

type RunItem = Record<string, unknown> & { provenance: Record<string, unknown> };
/** The fixture's four items: Policy, pinned, portable pick, user pick. */
const runItems = (): [RunItem, RunItem, RunItem, RunItem] =>
  structuredClone(
    (
      fixture("run-start-semantic").memory as {
        semantic: { items: [RunItem, RunItem, RunItem, RunItem] };
      }
    ).semantic.items,
  );
const semantic = (items: unknown[], omitted = 0) =>
  runSemanticMemorySchema.safeParse({ items, omitted_count: omitted });

describe("run.start.memory.semantic ordering and limits", () => {
  it("orders stable-first: Policy, pinned, then per-message picks", () => {
    const [policy, pinned, pick, pick2] = runItems();
    expect(semantic([policy, pinned, pick, pick2]).success).toBe(true);
    expect(semantic([pinned, policy, pick]).success).toBe(false);
    expect(semantic([policy, pick, pinned]).success).toBe(false);
    expect(semantic([]).success).toBe(true);
  });

  it("Policy exists only on the Site", () => {
    const [, pinned] = runItems();
    expect(semantic([{ ...pinned, policy: true }]).success).toBe(false);
  });

  it("Policy items are never pinned (always in context)", () => {
    const [policy] = runItems();
    expect(semantic([{ ...policy, pinned: true }]).success).toBe(false);
    const detail = fixture("item-detail-site");
    expect(semanticMemoryItemDetailSchema.safeParse(detail).success).toBe(true);
    expect(semanticMemoryItemDetailSchema.safeParse({ ...detail, pinned: true }).success).toBe(
      false,
    );
    expect(
      createSemanticMemoryItemSchema.safeParse({
        ...fixture("create-request"),
        scope: "site",
        policy: true,
        pinned: true,
      }).success,
    ).toBe(false);
    expect(SEMANTIC_MEMORY_ERROR_HTTP_STATUS.memory_policy_not_pinnable).toBe(409);
  });

  it("portable items are preferences without as_of", () => {
    const [, , portable] = runItems();
    expect(semantic([{ ...portable, kind: "fact" }]).success).toBe(false);
    expect(
      semantic([{ ...portable, provenance: { ...portable.provenance, as_of: "2026-10-01" } }])
        .success,
    ).toBe(false);
  });

  it("refuses duplicates, a statement over the cap and a block over the byte budgets", () => {
    const [policy, , , pick] = runItems();
    expect(semantic([pick, pick]).success).toBe(false);
    expect(
      semantic([{ ...pick, statement: "x".repeat(SEMANTIC_MEMORY_STATEMENT_MAX + 1) }]).success,
    ).toBe(false);
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...pick,
      id: `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`,
      statement: "y".repeat(500),
    }));
    expect(40 * 500).toBeGreaterThan(SEMANTIC_MEMORY_BLOCK_MAX_BYTES);
    expect(semantic(many).success).toBe(false);
    const policies = Array.from({ length: 5 }, (_, i) => ({
      ...policy,
      id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`,
      statement: "z".repeat(500),
    }));
    expect(5 * 500).toBeGreaterThan(SEMANTIC_MEMORY_POLICY_MAX_BYTES);
    expect(semantic(policies).success).toBe(false);
  });

  it("is strict: no evidence, thread links or unknown fields reach the sandbox", () => {
    const [, , , pick] = runItems();
    expect(semantic([{ ...pick, source_thread_id: pick.id }]).success).toBe(false);
    expect(
      semantic([{ ...pick, provenance: { ...pick.provenance, evidence: "quote" } }]).success,
    ).toBe(false);
    expect(semantic([pick], -1).success).toBe(false);
  });
});

describe("item API requests", () => {
  const create = (patch: Record<string, unknown>) =>
    createSemanticMemoryItemSchema.safeParse({ ...fixture("create-request"), ...patch });

  it("scopes are the wire names; the UI says Workspace", () => {
    expect(SEMANTIC_MEMORY_SCOPES).toEqual(["user", "portable", "team", "site"]);
    expect(SEMANTIC_MEMORY_SCOPE_LABELS).toEqual({
      user: { picker: "Me in this workspace", section: "My memories in this workspace" },
      portable: { picker: "All my workspaces", section: "My memories in all my workspaces" },
      team: { picker: "This workspace", section: "Workspace memories" },
      site: { picker: "Site", section: "Site memories" },
    });
  });

  it("checks statement, tags and scope rules", () => {
    expect(create({ statement: "   " }).success).toBe(false);
    expect(create({ statement: "x".repeat(501) }).success).toBe(false);
    expect(create({ tags: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
    expect(create({ tags: ["x".repeat(41)] }).success).toBe(false);
    expect(create({ tags: ["bad\ttag"] }).success).toBe(false);
    expect(create({ policy: true }).success).toBe(false);
    expect(create({ scope: "site", policy: true }).success).toBe(true);
    expect(create({ scope: "portable" }).success).toBe(false);
    expect(create({ scope: "portable", kind: "preference", as_of: undefined }).success).toBe(false);
    expect(
      create({ scope: "portable", kind: "preference", as_of: undefined, confirm_portable: true })
        .success,
    ).toBe(true);
    // KOBE-378: confirm_portable only (and always) on a portable save.
    expect(create({ confirm_portable: true }).success).toBe(false);
    // Review L-6: the replaced item's expected version only with supersedes_id.
    expect(create({ supersedes_expected_version: 2 }).success).toBe(false);
    expect(
      create({
        supersedes_id: "22222222-2222-4222-8222-222222222222",
        supersedes_expected_version: 2,
      }).success,
    ).toBe(true);
    expect(create({ scope: "site", source_thread_id: fixture("item-detail").id }).success).toBe(
      false,
    );
    expect(create({ kind: "policy" }).success).toBe(false);
    expect(create({ extra: 1 }).success).toBe(false);
  });

  it("source entries need their thread", () => {
    const thread = "22222222-2222-4222-8222-222222222222";
    expect(create({ source_thread_id: thread, source_entry_ids: ["e1"] }).success).toBe(true);
    expect(create({ source_entry_ids: ["e1"] }).success).toBe(false);
  });

  it("patch needs expected_version and at least one change", () => {
    expect(patchSemanticMemoryItemSchema.safeParse({ expected_version: 2 }).success).toBe(false);
    expect(patchSemanticMemoryItemSchema.safeParse({ statement: "x" }).success).toBe(false);
    expect(
      patchSemanticMemoryItemSchema.safeParse({ expected_version: 2, as_of: null }).success,
    ).toBe(true);
  });

  it("list query defaults to active items, 50 a page", () => {
    expect(semanticMemoryListQuerySchema.parse({ scope: "team" })).toEqual({
      scope: "team",
      status: "active",
      limit: 50,
    });
    expect(semanticMemoryListQuerySchema.safeParse({}).success).toBe(false);
    expect(semanticMemoryListQuerySchema.parse({ scope: "site", pinned: "true" }).pinned).toBe(
      true,
    );
  });
});

describe("import and export", () => {
  it("export takes json or csv; csv has fixed columns", () => {
    expect(
      semanticMemoryExportQuerySchema.safeParse({ scope: "user", format: "csv" }).success,
    ).toBe(true);
    expect(
      semanticMemoryExportQuerySchema.safeParse({ scope: "user", format: "xml" }).success,
    ).toBe(false);
    expect(SEMANTIC_MEMORY_CSV_COLUMNS).toEqual([
      "ref",
      "kind",
      "statement",
      "tags",
      "pinned",
      "as_of",
      "policy",
      "status",
      "superseded_by",
    ]);
  });

  it("commit names accepted rows, unique and non-empty", () => {
    const base = fixture("import-commit-request");
    const ok = (accept: unknown) =>
      semanticMemoryImportCommitRequestSchema.safeParse({ ...base, accept }).success;
    expect(ok([0, 2])).toBe(true);
    expect(ok([])).toBe(false);
    expect(ok([1, 1])).toBe(false);
    expect(ok([-1])).toBe(false);
  });
});

describe("errors, settings, names and labels (ac-3)", () => {
  it("has the error codes and their HTTP statuses", () => {
    for (const code of [
      "memory_scope_full",
      "memory_policy_conflict",
      "memory_secret",
      "memory_policy_budget_full",
      "memory_disabled",
      "memory_learning_model_unavailable",
    ])
      expect(SEMANTIC_MEMORY_ERROR_CODES).toContain(code);
    expect(Object.keys(SEMANTIC_MEMORY_ERROR_HTTP_STATUS).sort()).toEqual(
      [...SEMANTIC_MEMORY_ERROR_CODES].sort(),
    );
    expect(semanticMemoryErrorSchema.safeParse({ code: "nope", message: "x" }).success).toBe(false);
  });

  it("agent-version memory setting: all | notes_only | off, absent = all", () => {
    expect(AGENT_MEMORY_SETTINGS).toEqual(["all", "notes_only", "off"]);
    expect(agentVersionMemoryFieldSchema.parse({})).toEqual({ memory: "all" });
    expect(agentVersionMemoryFieldSchema.safeParse({ memory: "semantic_only" }).success).toBe(
      false,
    );
  });

  it("notification kinds are memory.* and in the live list (KOBE-645)", () => {
    expect(MEMORY_NOTIFICATION_KINDS.length).toBeGreaterThan(0);
    for (const kind of MEMORY_NOTIFICATION_KINDS) {
      expect(kind).toMatch(/^memory\.[a-z_]+\.[a-z_]+$/);
      expect(NOTIFICATION_KINDS as readonly string[]).toContain(kind);
    }
    expect(MEMORY_NOTIFICATION_KINDS).toContain("memory.suggestion.received");
    expect(new Set(MEMORY_NOTIFICATION_KINDS).size).toBe(MEMORY_NOTIFICATION_KINDS.length);
  });

  it("reserves Phase B/C audit names (pass, proposal, suggestion)", () => {
    for (const prefix of ["memory.pass.", "memory.proposal.", "memory.suggestion."])
      expect(RESERVED_MEMORY_AUDIT_ACTIONS.some((a) => a.startsWith(prefix))).toBe(true);
  });

  it("names the Site steward grant", () => {
    expect(MEMORY_STEWARD_SITE_GRANT).toBe("memory_steward");
  });

  it("labels one context-viewer memory section per lane", () => {
    expect(CONTEXT_MEMORY_LANES).toEqual(["notes", "policy", "site", "team", "portable", "user"]);
    expect(CONTEXT_MEMORY_SECTION_LABELS).toEqual({
      notes: "Saved memory",
      policy: "Policy",
      site: "Site memories",
      team: "Workspace memories",
      portable: "My memories in all my workspaces",
      user: "My memories in this workspace",
    });
  });
});
