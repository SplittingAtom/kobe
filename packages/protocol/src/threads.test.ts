import { describe, expect, it } from "vitest";
import {
  BRANCH_LABEL_ERROR_CODES,
  BRANCH_LABEL_ERROR_HTTP_STATUS,
  BRANCH_LABEL_MAX_CHARS,
  BRANCH_LABELS_MAX,
  BRANCH_SUMMARIES_MAX,
  BRANCH_SUMMARY_ERROR_CODES,
  BRANCH_SUMMARY_ERROR_HTTP_STATUS,
  BRANCH_SUMMARY_ERROR_MESSAGES,
  BRANCH_SUMMARY_FOCUS_MAX_CHARS,
  branchLabelErrorCodeSchema,
  branchLabelSchema,
  branchSummaryError,
  branchSummaryErrorCodeSchema,
  branchSummaryErrorSchema,
  branchSummaryFocusSchema,
  branchSummaryRequestSchema,
  CAPABILITY_THREAD_BRANCH_SUMMARY,
  LABEL_WRITE_RATE,
  LEAF_RATE,
  RUN_KIND_BRANCH_SUMMARY,
  setLabelBodySchema,
  THREAD_CARD_BRANCHES_MAX,
  threadBranchesResponseSchema,
  threadCardBranchesSchema,
  CAPABILITY_THREAD_COMPACT,
  COMPACT_THREAD_ERROR_CODES,
  COMPACT_THREAD_ERROR_HTTP_STATUS,
  COMPACT_THREAD_ERROR_MESSAGES,
  compactThreadError,
  compactThreadErrorSchema,
  compactThreadRequestSchema,
  compactThreadResponseSchema,
  THREAD_COMPACT_FOCUS_MAX_CHARS,
  THREAD_COMPACT_SUMMARY_MAX_BYTES,
  threadCompactFocusSchema,
  threadOrganizationSchema,
  createThreadFolderRequestSchema,
  fileThreadRequestSchema,
  LINEAGE_MAX_DEPTH,
  LINEAGE_MAX_SIBLINGS,
  THREAD_FOLDER_ERROR_CODES,
  THREAD_FOLDER_ERROR_HTTP_STATUS,
  THREAD_FOLDER_MAX_DEPTH,
  THREAD_FOLDER_NAME_MAX,
  THREAD_FOLDERS_MAX,
  threadFolderErrorCodeSchema,
  threadFolderFilterSchema,
  threadFolderNameSchema,
  threadFolderSchema,
  threadFoldersResponseSchema,
  threadLineageResponseSchema,
  updateThreadFolderRequestSchema,
} from "./index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

const FOLDER = "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e";

/** KOBE-212 (CE15): POST /v1/threads/{id}/compact. */
describe("compact thread request", () => {
  it("accepts no focus and a focus up to the limit", () => {
    expect(compactThreadRequestSchema.parse({})).toEqual({});
    const focus = "x".repeat(THREAD_COMPACT_FOCUS_MAX_CHARS);
    expect(compactThreadRequestSchema.parse({ focus })).toEqual({ focus });
    expect(compactThreadRequestSchema.parse({ focus: "Keep the SQL\nand the plan" })).toEqual({
      focus: "Keep the SQL\nand the plan",
    });
  });

  it("refuses an empty, blank, too long or control-character focus", () => {
    for (const focus of [
      "",
      "  \n\t ",
      "x".repeat(THREAD_COMPACT_FOCUS_MAX_CHARS + 1),
      "a\u0000b",
      "a\u001bb",
      "a\u007fb",
      "a\u2028b",
      "a\u202eb",
      "a\u2066b",
      42,
      null,
    ]) {
      expect(compactThreadRequestSchema.safeParse({ focus }).success, String(focus)).toBe(false);
    }
  });

  it("refuses unknown keys (strict)", () => {
    expect(compactThreadRequestSchema.safeParse({ focus: "a", model: "x" }).success).toBe(false);
  });

  it("keeps the focus as sent (no trimming on the contract)", () => {
    expect(threadCompactFocusSchema.parse(" the plan ")).toBe(" the plan ");
  });
});

describe("compact thread response", () => {
  const ok = {
    thread_id: EXAMPLE_IDS.thread,
    summary: "## Goal\nShip the report.",
    first_kept_entry_id: "c3d4e5f6",
    tokens_before: 150_000,
    estimated_tokens_after: 32_000,
  };

  it("accepts Pi's result shape, with optional summary and estimate", () => {
    expect(compactThreadResponseSchema.parse(ok)).toEqual(ok);
    const { summary: _s, estimated_tokens_after: _e, ...minimal } = ok;
    expect(compactThreadResponseSchema.parse(minimal)).toEqual(minimal);
  });

  it("refuses bad counts, ids and unknown keys", () => {
    for (const bad of [
      { ...ok, tokens_before: -1 },
      { ...ok, tokens_before: 1.5 },
      { ...ok, estimated_tokens_after: -3 },
      { ...ok, first_kept_entry_id: "" },
      { ...ok, first_kept_entry_id: "a\nb" },
      { ...ok, first_kept_entry_id: "x".repeat(129) },
      { ...ok, summary: "" },
      { ...ok, thread_id: "not-a-uuid" },
      { ...ok, details: {} },
    ]) {
      expect(compactThreadResponseSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("caps the summary in UTF-8 bytes", () => {
    const max = "a".repeat(THREAD_COMPACT_SUMMARY_MAX_BYTES);
    expect(compactThreadResponseSchema.safeParse({ ...ok, summary: max }).success).toBe(true);
    const over = "é".repeat(THREAD_COMPACT_SUMMARY_MAX_BYTES / 2) + "a";
    expect(compactThreadResponseSchema.safeParse({ ...ok, summary: over }).success).toBe(false);
  });
});

describe("compact thread errors", () => {
  it("names the codes and their HTTP status", () => {
    expect(COMPACT_THREAD_ERROR_CODES).toEqual([
      "thread_busy",
      "sandbox_unavailable",
      "nothing_to_compact",
      "model_not_configured",
      "compaction_failed",
    ]);
    expect(COMPACT_THREAD_ERROR_HTTP_STATUS).toEqual({
      thread_busy: 409,
      sandbox_unavailable: 503,
      nothing_to_compact: 409,
      model_not_configured: 409,
      compaction_failed: 502,
    });
  });

  it("answers each code with its fixed message", () => {
    for (const code of COMPACT_THREAD_ERROR_CODES) {
      const body = compactThreadError(code);
      expect(body).toEqual({ code, message: COMPACT_THREAD_ERROR_MESSAGES[code] });
      expect(compactThreadErrorSchema.parse(body)).toEqual(body);
    }
  });

  it("refuses any other message (never Pi's or the sandbox's text), unknown codes and keys", () => {
    for (const bad of [
      { code: "compaction_failed", message: "Compaction failed: 401 from http://gateway/v1" },
      { code: "thread_busy", message: COMPACT_THREAD_ERROR_MESSAGES.compaction_failed },
      { code: "busy", message: COMPACT_THREAD_ERROR_MESSAGES.thread_busy },
      { ...compactThreadError("thread_busy"), detail: "x" },
      { code: "thread_busy" },
    ]) {
      expect(compactThreadErrorSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("gates the wire command on a hello capability", () => {
    expect(CAPABILITY_THREAD_COMPACT).toBe("thread_compact");
  });
});

/** KOBE-215 (CE16, CE18, CE19): pin, archive, title lock and fork provenance on a thread summary. */
describe("thread organization fields", () => {
  const full = {
    pinned_at: "2026-10-14T08:00:00Z",
    archived_at: "2026-10-14T09:30:00.123Z",
    title_locked: true,
    forked_from_thread_id: EXAMPLE_IDS.thread,
    forked_at_entry_id: "c3d4e5f6",
    folder_id: FOLDER,
  };

  it("decodes absent fields as not pinned, not archived, unlocked, not a fork (additive)", () => {
    expect(threadOrganizationSchema.parse({})).toEqual({
      pinned_at: null,
      archived_at: null,
      title_locked: false,
      forked_from_thread_id: null,
      forked_at_entry_id: null,
      folder_id: null,
    });
  });

  it("accepts every field set, and nulls", () => {
    expect(threadOrganizationSchema.parse(full)).toEqual(full);
    const nulls = {
      pinned_at: null,
      archived_at: null,
      title_locked: false,
      forked_from_thread_id: null,
      forked_at_entry_id: null,
      folder_id: null,
    };
    expect(threadOrganizationSchema.parse(nulls)).toEqual(nulls);
  });

  it("parses a KOBE-215 summary that predates folders (no folder_id)", () => {
    const { folder_id: _omit, ...old } = full;
    expect(threadOrganizationSchema.parse(old)).toEqual({ ...old, folder_id: null });
  });

  it("keeps a fork point whose source thread is gone (purged source)", () => {
    const orphan = { ...full, forked_from_thread_id: null };
    expect(threadOrganizationSchema.parse(orphan)).toEqual(orphan);
  });

  it("refuses malformed values", () => {
    for (const bad of [
      { ...full, pinned_at: "yesterday" },
      { ...full, archived_at: "2026-10-14T08:00:00+02:00" },
      { ...full, title_locked: null },
      { ...full, title_locked: "true" },
      { ...full, forked_from_thread_id: "not-a-uuid" },
      { ...full, forked_from_thread_id: EXAMPLE_IDS.thread.toUpperCase() },
      { ...full, forked_at_entry_id: "" },
      { ...full, forked_at_entry_id: "x".repeat(129) },
      { ...full, forked_at_entry_id: "a\nb" },
      { ...full, folder_id: "not-a-uuid" },
      { ...full, folder_id: FOLDER.toUpperCase() },
    ]) {
      expect(threadOrganizationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

/** KOBE-532 (TL1, TL9): `GET /v1/threads/{id}/lineage`. */
describe("thread lineage response", () => {
  const A = "a1a2a3a4-b5b6-4c7c-8d8d-e9e9f0f0a1a2";
  const B = "b1b2b3b4-c5c6-4d7d-8e8e-f9f9a0a0b1b2";
  const C = "c1c2c3c4-d5d6-4e7e-8f8f-a9a9b0b0c1c2";
  const sibling = (thread_id: string, owner: "me" | "other" = "me") => ({
    thread_id,
    title: "Budget 2027",
    deleted_at: null,
    owner,
  });
  const full = {
    thread_id: EXAMPLE_IDS.thread,
    root_hidden: false,
    ancestors: [
      { thread_id: A, title: "Budget 2027", deleted_at: null, siblings: [], siblings_more: false },
      {
        thread_id: B,
        title: null,
        deleted_at: "2026-10-30T10:00:00Z",
        siblings: [sibling(B), sibling(C, "other")],
        siblings_more: true,
      },
    ],
    self: {
      thread_id: EXAMPLE_IDS.thread,
      title: "Try the Q3 numbers",
      forked_at_entry_id: "c3d4e5f6",
      siblings: [sibling(EXAMPLE_IDS.thread)],
      siblings_more: false,
    },
    forks: [{ ...sibling(C, "other"), deleted_at: "2026-10-30T10:00:00Z" }],
    forks_more: false,
  };

  it("pins the caps", () => {
    expect(LINEAGE_MAX_DEPTH).toBe(20);
    expect(LINEAGE_MAX_SIBLINGS).toBe(50);
  });

  it("accepts a full family", () => {
    expect(threadLineageResponseSchema.parse(full)).toEqual(full);
  });

  it("accepts an ordinary thread (no ancestors, no forks) and defaults absent more flags", () => {
    const plain = {
      thread_id: EXAMPLE_IDS.thread,
      root_hidden: false,
      ancestors: [],
      self: { thread_id: EXAMPLE_IDS.thread, title: null, forked_at_entry_id: null, siblings: [] },
      forks: [],
    };
    expect(threadLineageResponseSchema.parse(plain)).toEqual({
      ...plain,
      self: { ...plain.self, siblings_more: false },
      forks_more: false,
    });
  });

  it("accepts lists at the cap and refuses longer ones", () => {
    const many = Array.from({ length: LINEAGE_MAX_SIBLINGS }, () => sibling(C));
    const atCap = { ...full, forks: many, self: { ...full.self, siblings: many } };
    expect(threadLineageResponseSchema.safeParse(atCap).success).toBe(true);
    const over = [...many, sibling(C)];
    expect(threadLineageResponseSchema.safeParse({ ...full, forks: over }).success).toBe(false);
    expect(
      threadLineageResponseSchema.safeParse({ ...full, self: { ...full.self, siblings: over } })
        .success,
    ).toBe(false);
    const deep = Array.from({ length: LINEAGE_MAX_DEPTH + 1 }, () => full.ancestors[0]);
    expect(threadLineageResponseSchema.safeParse({ ...full, ancestors: deep }).success).toBe(false);
  });

  it("refuses malformed and unknown shapes (strict)", () => {
    for (const bad of [
      { ...full, extra: 1 },
      { ...full, root_hidden: undefined },
      { ...full, thread_id: "nope" },
      { ...full, ancestors: [{ ...full.ancestors[0], owner: "me" }] },
      { ...full, ancestors: [{ ...full.ancestors[0], siblings: undefined }] },
      { ...full, self: { ...full.self, deleted_at: null } },
      { ...full, self: { ...full.self, forked_at_entry_id: "" } },
      { ...full, forks: [{ ...sibling(C), owner: "admin" }] },
      { ...full, forks: [{ ...sibling(C), extra: true }] },
      { ...full, forks: [{ ...sibling(C), deleted_at: "yesterday" }] },
      { ...full, forks_more: "yes" },
    ]) {
      expect(threadLineageResponseSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

/** KOBE-532 (TF1-TF5): thread folders. */
describe("thread folders", () => {
  const folder = {
    id: FOLDER,
    parent_id: null,
    name: "Budget",
    position: 0,
    created_by: EXAMPLE_IDS.user,
    threads: 3,
  };

  it("pins the limits", () => {
    expect(THREAD_FOLDER_NAME_MAX).toBe(80);
    expect(THREAD_FOLDER_MAX_DEPTH).toBe(3);
    expect(THREAD_FOLDERS_MAX).toBe(500);
  });

  it("trims names and keeps 1-80 characters", () => {
    expect(threadFolderNameSchema.parse("  Q3 plans ")).toBe("Q3 plans");
    expect(threadFolderNameSchema.parse("x".repeat(80))).toBe("x".repeat(80));
    for (const bad of ["", "   ", "x".repeat(81), "a\u0000b", "a\nb", "a\u202eb", 7, null]) {
      expect(threadFolderNameSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it("accepts a folder and a list of folders", () => {
    expect(threadFolderSchema.parse(folder)).toEqual(folder);
    const child = { ...folder, id: EXAMPLE_IDS.file, parent_id: FOLDER, position: 2, threads: 0 };
    expect(threadFoldersResponseSchema.parse({ folders: [folder, child] })).toEqual({
      folders: [folder, child],
    });
    expect(threadFoldersResponseSchema.parse({ folders: [] })).toEqual({ folders: [] });
  });

  it("refuses malformed folders and lists", () => {
    for (const bad of [
      { ...folder, extra: 1 },
      { ...folder, parent_id: undefined },
      { ...folder, threads: -1 },
      { ...folder, threads: 1.5 },
      { ...folder, position: -1 },
      { ...folder, name: "" },
      { ...folder, created_by: "me" },
    ]) {
      expect(threadFolderSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(threadFoldersResponseSchema.safeParse({}).success).toBe(false);
    expect(threadFoldersResponseSchema.safeParse({ folders: [], more: true }).success).toBe(false);
    const tooMany = Array.from({ length: THREAD_FOLDERS_MAX + 1 }, () => folder);
    expect(threadFoldersResponseSchema.safeParse({ folders: tooMany }).success).toBe(false);
  });

  it("creates with a name and an optional parent", () => {
    expect(createThreadFolderRequestSchema.parse({ name: " A " })).toEqual({ name: "A" });
    expect(createThreadFolderRequestSchema.parse({ name: "A", parent_id: FOLDER })).toEqual({
      name: "A",
      parent_id: FOLDER,
    });
    for (const bad of [
      {},
      { name: "" },
      { name: "A", parent_id: null },
      { name: "A", parent_id: "x" },
      { name: "A", position: 1 },
    ]) {
      expect(createThreadFolderRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it("updates any one field, moves to the top level with null, and refuses an empty patch", () => {
    for (const ok of [
      { name: "B" },
      { parent_id: null },
      { parent_id: FOLDER },
      { position: 4 },
      { name: "B", parent_id: FOLDER, position: 0 },
    ]) {
      expect(updateThreadFolderRequestSchema.parse(ok)).toEqual(ok);
    }
    for (const bad of [
      {},
      { name: " " },
      { parent_id: "x" },
      { position: -1 },
      { position: 1.5 },
      { name: "B", extra: 1 },
    ]) {
      expect(updateThreadFolderRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it("files into a folder or out of one", () => {
    expect(fileThreadRequestSchema.parse({ folder_id: FOLDER })).toEqual({ folder_id: FOLDER });
    expect(fileThreadRequestSchema.parse({ folder_id: null })).toEqual({ folder_id: null });
    for (const bad of [{}, { folder_id: "none" }, { folder_id: FOLDER, pinned: true }]) {
      expect(fileThreadRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("filters a thread list by folder id or none", () => {
    expect(threadFolderFilterSchema.parse(FOLDER)).toBe(FOLDER);
    expect(threadFolderFilterSchema.parse("none")).toBe("none");
    for (const bad of ["", "all", "None", FOLDER.toUpperCase(), null]) {
      expect(threadFolderFilterSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it("maps every folder error code to its HTTP status", () => {
    expect(THREAD_FOLDER_ERROR_HTTP_STATUS).toEqual({
      folder_not_found: 404,
      folder_name_taken: 409,
      folder_too_deep: 409,
      folder_cycle: 409,
      folder_limit: 409,
      thread_in_trash: 409,
      test_thread: 409,
    });
    expect(Object.keys(THREAD_FOLDER_ERROR_HTTP_STATUS).sort()).toEqual(
      [...THREAD_FOLDER_ERROR_CODES].sort(),
    );
    expect(threadFolderErrorCodeSchema.safeParse("folder_full").success).toBe(false);
  });
});

// --- Conversation tree (KOBE-542, CT2, CT3, CT9, CT11, CT12, CT20) ---------------------------------

describe("branch labels (CT9)", () => {
  it("sets a trimmed one-line label of 1-60 characters, or clears it with null", () => {
    expect(setLabelBodySchema.parse({ label: "  try 5% cut " })).toEqual({ label: "try 5% cut" });
    expect(setLabelBodySchema.parse({ label: null })).toEqual({ label: null });
    expect(
      setLabelBodySchema.parse({ label: "x".repeat(BRANCH_LABEL_MAX_CHARS) }).label,
    ).toHaveLength(BRANCH_LABEL_MAX_CHARS);
    expect(branchLabelSchema.parse("the good answer")).toBe("the good answer");
  });

  it("refuses blank, long, multi-line and control or bidi labels, a missing label and extras", () => {
    for (const label of [
      "",
      "   ",
      "x".repeat(BRANCH_LABEL_MAX_CHARS + 1),
      "two\nlines",
      "tab\there",
      "a b",
      "rtl‮override",
      "nul\u0000",
      42,
    ]) {
      expect(setLabelBodySchema.safeParse({ label }).success, JSON.stringify(label)).toBe(false);
    }
    expect(setLabelBodySchema.safeParse({}).success).toBe(false);
    expect(setLabelBodySchema.safeParse({ label: "ok", entry_id: "e1" }).success).toBe(false);
  });

  it("has the limits and error codes of the spec", () => {
    expect(BRANCH_LABEL_MAX_CHARS).toBe(60);
    expect(BRANCH_LABELS_MAX).toBe(200);
    expect(BRANCH_LABEL_ERROR_HTTP_STATUS).toEqual({
      entry_not_found: 404,
      label_limit: 409,
      thread_in_trash: 409,
      test_thread: 409,
    });
    expect(Object.keys(BRANCH_LABEL_ERROR_HTTP_STATUS).sort()).toEqual(
      [...BRANCH_LABEL_ERROR_CODES].sort(),
    );
    expect(branchLabelErrorCodeSchema.safeParse("entry_not_found").success).toBe(true);
    expect(branchLabelErrorCodeSchema.safeParse("folder_not_found").success).toBe(false);
  });
});

describe("thread branches response (CT2)", () => {
  const valid = {
    labels: [{ entry_id: "a1b2c3d4", label: "try 5% cut" }],
    runs: [
      { user_entry_id: "a1b2c3d4", remembered_rule: true },
      { user_entry_id: "e5f6a7b8", remembered_rule: false },
    ],
  };

  it("parses labels and runs, and empty lists", () => {
    expect(threadBranchesResponseSchema.parse(valid)).toEqual(valid);
    expect(threadBranchesResponseSchema.parse({ labels: [], runs: [] })).toEqual({
      labels: [],
      runs: [],
    });
  });

  it("caps labels at BRANCH_LABELS_MAX", () => {
    const label = (i: number) => ({ entry_id: `e${i}`, label: `l${i}` });
    const at = Array.from({ length: BRANCH_LABELS_MAX }, (_, i) => label(i));
    expect(threadBranchesResponseSchema.safeParse({ labels: at, runs: [] }).success).toBe(true);
    expect(
      threadBranchesResponseSchema.safeParse({
        labels: [...at, label(BRANCH_LABELS_MAX)],
        runs: [],
      }).success,
    ).toBe(false);
  });

  it("refuses missing lists, bad items and unknown keys", () => {
    for (const bad of [
      { labels: [] },
      { runs: [] },
      { ...valid, extra: 1 },
      { ...valid, labels: [{ entry_id: "a1", label: "" }] },
      { ...valid, labels: [{ entry_id: "", label: "x" }] },
      { ...valid, labels: [{ entry_id: "a1", label: "x", by: "me" }] },
      { ...valid, runs: [{ user_entry_id: "a1" }] },
      { ...valid, runs: [{ user_entry_id: "a1", remembered_rule: "yes" }] },
      { ...valid, runs: [{ user_entry_id: "a1", remembered_rule: true, run_id: "r" }] },
    ]) {
      expect(threadBranchesResponseSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("leaf move rate (CT3)", () => {
  it("is 120 per 10 minutes, in the server's rate-limit rule shape", () => {
    expect(LEAF_RATE).toEqual({ windowMs: 10 * 60_000, max: 120 });
  });
});

describe("label write rate (CT9)", () => {
  it("is 60 per 10 minutes, in the server's rate-limit rule shape", () => {
    expect(LABEL_WRITE_RATE).toEqual({ windowMs: 10 * 60_000, max: 60 });
  });
});

describe("hover card branches (CT12)", () => {
  it("parses a count with its capped flag", () => {
    expect(threadCardBranchesSchema.parse({ branches: 3, branches_capped: false })).toEqual({
      branches: 3,
      branches_capped: false,
    });
    expect(
      threadCardBranchesSchema.parse({ branches: THREAD_CARD_BRANCHES_MAX, branches_capped: true }),
    ).toEqual({ branches: THREAD_CARD_BRANCHES_MAX, branches_capped: true });
  });

  it("parses an old card without them", () => {
    expect(threadCardBranchesSchema.parse({})).toEqual({});
  });

  it("refuses negative, fractional, over-cap counts and unknown keys", () => {
    for (const bad of [
      { branches: -1 },
      { branches: 1.5 },
      { branches: THREAD_CARD_BRANCHES_MAX + 1 },
      { branches: "3" },
      { branches_capped: "no" },
      { branches: 1, junctions: 1 },
    ]) {
      expect(threadCardBranchesSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("branch summary request (CT11)", () => {
  it("names the run kind and the limits", () => {
    expect(RUN_KIND_BRANCH_SUMMARY).toBe("branch_summary");
    expect(BRANCH_SUMMARIES_MAX).toBe(20);
    expect(BRANCH_SUMMARY_FOCUS_MAX_CHARS).toBe(THREAD_COMPACT_FOCUS_MAX_CHARS);
    expect(CAPABILITY_THREAD_BRANCH_SUMMARY).toBe("thread_branch_summary");
  });

  it("parses a target with or without a one-line focus", () => {
    expect(branchSummaryRequestSchema.parse({ to_entry_id: "a1b2c3d4" })).toEqual({
      to_entry_id: "a1b2c3d4",
    });
    const focused = { to_entry_id: "a1b2c3d4", focus: "Keep the pricing numbers" };
    expect(branchSummaryRequestSchema.parse(focused)).toEqual(focused);
  });

  it("refuses a missing target, a bad focus and unknown keys", () => {
    for (const bad of [
      {},
      { to_entry_id: "" },
      { to_entry_id: "a1", focus: "" },
      { to_entry_id: "a1", focus: "  " },
      { to_entry_id: "a1", focus: "two\nlines" },
      { to_entry_id: "a1", focus: "bidi‮" },
      { to_entry_id: "a1", focus: "x".repeat(BRANCH_SUMMARY_FOCUS_MAX_CHARS + 1) },
      { to_entry_id: "a1", from_leaf_entry_id: "b2" },
    ]) {
      expect(branchSummaryRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(branchSummaryFocusSchema.safeParse("ok").success).toBe(true);
  });
});

describe("branch summary errors (CT11)", () => {
  it("has a status and a fixed message per code", () => {
    expect(BRANCH_SUMMARY_ERROR_HTTP_STATUS).toEqual({
      thread_busy: 409,
      sandbox_unavailable: 503,
      model_not_configured: 409,
      nothing_to_summarize: 409,
      summary_limit: 409,
      summary_failed: 502,
      read_only: 403,
      test_thread: 409,
    });
    for (const code of BRANCH_SUMMARY_ERROR_CODES) {
      expect(BRANCH_SUMMARY_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
      expect(branchSummaryError(code)).toEqual({
        code,
        message: BRANCH_SUMMARY_ERROR_MESSAGES[code],
      });
    }
    expect(BRANCH_SUMMARY_ERROR_MESSAGES.summary_limit).toMatch(/Compact the thread first/);
  });

  it("refuses an unknown code, another message and extras", () => {
    expect(branchSummaryErrorCodeSchema.safeParse("nothing_to_compact").success).toBe(false);
    expect(
      branchSummaryErrorSchema.safeParse({ code: "thread_busy", message: "nope" }).success,
    ).toBe(false);
    expect(
      branchSummaryErrorSchema.safeParse({ ...branchSummaryError("summary_failed"), detail: "x" })
        .success,
    ).toBe(false);
  });
});
