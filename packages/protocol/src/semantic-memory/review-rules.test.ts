import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_MEMORY_SECTION_LABELS,
  SEMANTIC_MEMORY_BLOCK_MAX_BYTES,
  SEMANTIC_MEMORY_ERROR_HTTP_STATUS,
  SEMANTIC_MEMORY_SCOPE_LABELS,
  SEMANTIC_MEMORY_SCOPES,
  createSemanticMemoryItemSchema,
  memoryStewardLevelSchema,
  restoreCsvCell,
  neutraliseCsvCell,
  runSemanticMemorySchema,
  semanticMemoryExportDocumentSchema,
  semanticMemoryExportToCsv,
  semanticMemoryImportCommitResponseSchema,
  semanticMemoryImportRowSchema,
  semanticMemoryItemActionSchema,
  pinSemanticMemoryItemSchema,
  semanticMemoryItemDetailSchema,
  semanticMemoryItemSchema,
  semanticMemoryRenderedBytes,
  semanticMemoryStatementSchema,
  semanticMemoryTagSchema,
  type RunSemanticMemoryItem,
  type SemanticMemoryExportDocument,
} from "../index.js";

/** KOBE-377 review (docs/ledger/review-377.md): M2-M6 and the lows, as rules. */

const FIXTURES = join(import.meta.dirname, "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(read(`${name}.json`)) as Record<string, unknown>;

const pick = (i: number, statement: string): RunSemanticMemoryItem => ({
  id: `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`,
  version: 1,
  scope: "user",
  kind: "fact",
  statement,
  policy: false,
  pinned: false,
  provenance: { actor_kind: "user", as_of: null, saved_on: "2026-11-01" },
});

describe("M2: the 8 KiB budget is the rendered block", () => {
  it("counts fences, lane headers and per-item lines, not statements alone", () => {
    const items = Array.from({ length: 15 }, (_, i) => pick(i, "x".repeat(500)));
    // 7,500 statement bytes fit the old statement-only count; rendered, they don't.
    expect(15 * 500).toBeLessThan(SEMANTIC_MEMORY_BLOCK_MAX_BYTES);
    const semantic = { items, omitted_count: 0 };
    expect(semanticMemoryRenderedBytes(semantic)).toBeGreaterThan(SEMANTIC_MEMORY_BLOCK_MAX_BYTES);
    expect(runSemanticMemorySchema.safeParse(semantic).success).toBe(false);
  });

  it("the golden fixture fits, and the helper grows with lanes and items", () => {
    const run = fixture("run-start-semantic").memory as { semantic: never };
    const bytes = semanticMemoryRenderedBytes(run.semantic);
    expect(bytes).toBeLessThanOrEqual(SEMANTIC_MEMORY_BLOCK_MAX_BYTES);
    expect(semanticMemoryRenderedBytes({ items: [], omitted_count: 0 })).toBeGreaterThan(0);
    const one = semanticMemoryRenderedBytes({ items: [pick(1, "ab")], omitted_count: 0 });
    const two = semanticMemoryRenderedBytes({
      items: [pick(1, "ab"), pick(2, "ab")],
      omitted_count: 0,
    });
    expect(two - one).toBeGreaterThan(2);
  });
});

describe("M3: export keeps status and supersession; CSV is not injectable", () => {
  const doc = fixture("export-document") as unknown as SemanticMemoryExportDocument;

  it("superseded_by is set exactly on superseded items and names a ref in the file", () => {
    const items = structuredClone(doc.items);
    const bad = (patch: Partial<(typeof items)[number]>, at = 1) => {
      const copy = structuredClone(items);
      const base = copy[at];
      if (!base) throw new Error("no such row");
      copy[at] = { ...base, ...patch };
      return semanticMemoryExportDocumentSchema.safeParse({ ...doc, items: copy }).success;
    };
    expect(bad({ superseded_by: null })).toBe(false);
    expect(bad({ superseded_by: "99999999-9999-4999-8999-999999999999" })).toBe(false);
    expect(bad({ status: "active" })).toBe(false);
    expect(bad({ ref: items[0]?.ref ?? "" })).toBe(false);
    expect(
      semanticMemoryExportDocumentSchema.safeParse({ ...doc, include_inactive: false }).success,
    ).toBe(false);
  });

  it("neutralises formula cells on export and restores them on import", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      const cell = `${lead}SUM(A1)`;
      expect(neutraliseCsvCell(cell)).toBe(`'${cell}`);
      expect(restoreCsvCell(neutraliseCsvCell(cell))).toBe(cell);
    }
    expect(neutraliseCsvCell("plain")).toBe("plain");
    expect(restoreCsvCell("'quoted")).toBe("'quoted");
  });

  it("the CSV of the golden export is the golden CSV", () => {
    expect(semanticMemoryExportToCsv(doc)).toBe(read("export.csv"));
  });
});

describe("M4: import limits, policy on rows, all-or-nothing commit", () => {
  it("rows carry policy; commit reports created items only", () => {
    const row = (fixture("import-preview-response").rows as Record<string, unknown>[])[0];
    expect(semanticMemoryImportRowSchema.safeParse({ ...row, policy: undefined }).success).toBe(
      false,
    );
    expect(
      semanticMemoryImportCommitResponseSchema.safeParse({
        ...fixture("import-commit-response"),
        skipped: 0,
      }).success,
    ).toBe(false);
  });

  it("names the limit and stale-preview errors", () => {
    expect(SEMANTIC_MEMORY_ERROR_HTTP_STATUS.memory_import_too_large).toBe(413);
    expect(SEMANTIC_MEMORY_ERROR_HTTP_STATUS.memory_import_stale).toBe(409);
  });
});

describe("M6 + L4: response shapes keep the walls and the scope rules", () => {
  const team = fixture("item-detail");
  const site = fixture("item-detail-site");
  const portable = fixture("item-detail-portable");
  const ok = (v: unknown) => semanticMemoryItemDetailSchema.safeParse(v).success;
  const withVersion = (d: Record<string, unknown>, patch: Record<string, unknown>) => ({
    ...d,
    versions: (d.versions as Record<string, unknown>[]).map((v) => ({ ...v, ...patch })),
  });

  it("portable and Site versions carry no thread links", () => {
    const link = {
      source_thread_id: "22222222-2222-4222-8222-222222222222",
      source_entry_ids: ["e1"],
    };
    expect(ok(withVersion(team, link))).toBe(true);
    expect(ok(withVersion(site, link))).toBe(false);
    expect(ok(withVersion(portable, link))).toBe(false);
  });

  it("author ids may be withheld only on Site items", () => {
    expect(ok(site)).toBe(true);
    expect(ok({ ...team, updated_by: null })).toBe(false);
    expect(ok(withVersion(team, { actor_user_id: null }))).toBe(false);
  });

  it("owner, kind, as_of, policy and supersession follow the scope rules", () => {
    expect(ok({ ...portable, owner_user_id: null })).toBe(false);
    expect(ok({ ...team, owner_user_id: portable.owner_user_id })).toBe(false);
    expect(ok({ ...portable, kind: "fact" })).toBe(false);
    expect(ok({ ...portable, as_of: "2026-10-01" })).toBe(false);
    expect(ok({ ...team, policy: true, pinned: false })).toBe(false);
    expect(ok({ ...portable, superseded_by: null })).toBe(false);
    expect(ok({ ...team, superseded_by: portable.superseded_by })).toBe(false);
    const { versions: _v, ...item } = team;
    expect(semanticMemoryItemSchema.safeParse(item).success).toBe(true);
    expect(semanticMemoryItemSchema.safeParse({ ...item, scope: "portable" }).success).toBe(false);
  });
});

describe("lows", () => {
  it("L1: memory_disabled is 403, as in the Notes routes", () => {
    expect(SEMANTIC_MEMORY_ERROR_HTTP_STATUS.memory_disabled).toBe(403);
  });

  it("L2: lengths count code points, like char_length", () => {
    expect(semanticMemoryStatementSchema.safeParse("😀".repeat(500)).success).toBe(true);
    expect(semanticMemoryStatementSchema.safeParse("😀".repeat(501)).success).toBe(false);
    expect(semanticMemoryTagSchema.safeParse("😀".repeat(40)).success).toBe(true);
    expect(semanticMemoryTagSchema.safeParse("😀".repeat(41)).success).toBe(false);
  });

  it("L3: one scope vocabulary; context labels come from the scope map", () => {
    expect(memoryStewardLevelSchema.options).toEqual(["team", "site"]);
    for (const scope of SEMANTIC_MEMORY_SCOPES)
      expect(CONTEXT_MEMORY_SECTION_LABELS[scope]).toBe(
        SEMANTIC_MEMORY_SCOPE_LABELS[scope].section,
      );
  });

  it("L6: statements refuse control characters but keep newlines; tags are trimmed", () => {
    expect(semanticMemoryStatementSchema.safeParse("line one\nline two").success).toBe(true);
    expect(semanticMemoryStatementSchema.safeParse("bell \u0007").success).toBe(false);
    expect(semanticMemoryTagSchema.safeParse(" ").success).toBe(false);
    expect(semanticMemoryTagSchema.safeParse(" padded").success).toBe(false);
  });

  it("M5 context: create carries pinned and policy (audited on created)", () => {
    expect(
      createSemanticMemoryItemSchema.safeParse({
        scope: "site",
        kind: "convention",
        statement: "Say Workspace, not team.",
        policy: true,
      }).success,
    ).toBe(true);
  });
});

describe("L7: archive, restore and pin take an optional expected_version", () => {
  it("accepts it, or nothing; refuses junk", () => {
    expect(semanticMemoryItemActionSchema.safeParse({}).success).toBe(true);
    expect(semanticMemoryItemActionSchema.safeParse({ expected_version: 3 }).success).toBe(true);
    expect(semanticMemoryItemActionSchema.safeParse({ expected_version: 0 }).success).toBe(false);
    expect(semanticMemoryItemActionSchema.safeParse({ other: 1 }).success).toBe(false);
    expect(
      pinSemanticMemoryItemSchema.safeParse({ pinned: true, expected_version: 2 }).success,
    ).toBe(true);
  });
});
