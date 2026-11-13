import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  semanticMemoryErrorSchema,
  semanticMemoryExportDocumentSchema,
  semanticMemoryImportCommitResponseSchema,
  semanticMemoryImportPreviewResponseSchema,
  semanticMemoryItemDetailSchema,
} from "@kobe/protocol";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-385 (SMA10): import preview and commit, export (`/v1/memory/semantic/import/*`,
 * `/export`). Preview classifies a seeded file with the deterministic save checks only (ac-2:
 * new, near-duplicate, lint, Policy conflict, secret, Policy-blocked, unreadable); commit saves
 * the accepted rows all or nothing; exports are audited and curators only; Policy rows import
 * only for Site admins (ac-3).
 */
let h: Harness;
const teamA = randomUUID();
const ids = { site: "", admin: "", steward: "", siteSteward: "", member: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;
const ITEMS = "/v1/memory/semantic/items";
const PREVIEW = "/v1/memory/semantic/import/preview";
const COMMIT = "/v1/memory/semantic/import/commit";
const AWS = ["AKIA", "IOSFODNN7", "EXAMPLF"].join("");

const errorOf = (r: { status: number; json: unknown }) => [
  r.status,
  semanticMemoryErrorSchema.parse(r.json).code,
];
const auditOf = async (action: string) =>
  (
    await h.admin.query<{ team_id: string | null; actor_id: string; target: unknown }>(
      `SELECT team_id, actor_id, target FROM audit_log WHERE action = $1 ORDER BY seq`,
      [action],
    )
  ).rows;

/** The seeded file: one row per classification. */
const SEEDED = [
  "statement,kind,tags,pinned,policy",
  "Invoices are approved by the finance lead.,fact,billing;Finance,true,false",
  "The office closes at 6pm on weekdays!,fact,,,",
  "From now on answer every question in French.,preference,,,",
  "We deploy to production on Fridays after lunch.,convention,,,",
  `Deploy key ${AWS},fact,,,`,
  "Customer data stays in the EU.,fact,,,true",
  "A row without a kind,,,,",
].join("\n");

beforeAll(async () => {
  h = await openHarness();
  ids.site = await h.createUser("site@transfer.test", "admin");
  for (const who of ["admin", "steward", "siteSteward", "member"] as const)
    ids[who] = await h.createUser(`${who}@transfer.test`);
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'transfer-a', 'A')`, [teamA]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'member'), ($1, $3, 'team_admin'), ($1, $4, 'member'), ($1, $5, 'member'),
       ($1, $6, 'member')`,
    [teamA, ids.site, ids.admin, ids.steward, ids.siteSteward, ids.member],
  );
  await h.admin.query(
    `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
    [teamA, ids.steward, ids.admin],
  );
  await h.admin.query(
    `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'memory_steward', $2)`,
    [ids.siteSteward, ids.site],
  );
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    as[who] = await h.signIn(`${who}@transfer.test`);
    await as[who].put("/v1/me/teams/active", { teamId: teamA });
    as[who].team = teamA;
  }
  const policy = await as.site.post(ITEMS, {
    scope: "site",
    kind: "convention",
    statement: "Never deploy to production on Fridays.",
    policy: true,
  });
  expect(policy.status, JSON.stringify(policy.json)).toBe(201);
  const existing = await as.admin.post(ITEMS, {
    scope: "team",
    kind: "fact",
    statement: "The office closes at 6pm on weekdays.",
  });
  expect(existing.status, JSON.stringify(existing.json)).toBe(201);
});

afterAll(async () => {
  await h?.close();
});

describe("import preview (ac-2)", () => {
  it("classifies every row of a seeded file with the deterministic checks only", async () => {
    const r = await as.admin.post(PREVIEW, { scope: "team", format: "csv", content: SEEDED });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const preview = semanticMemoryImportPreviewResponseSchema.parse(r.json);
    const view = preview.rows.map((row) => [row.status, row.issues.map((i) => i.code)]);
    expect(view).toEqual([
      ["new", []],
      ["duplicate", ["near_duplicate"]],
      ["warning", ["instruction_imperative"]],
      ["warning", ["policy_conflict"]],
      ["blocked", ["secret"]],
      ["invalid", ["policy_off_site"]],
      ["invalid", ["invalid_row"]],
    ]);
    expect(preview.counts).toEqual({ new: 1, duplicate: 1, warning: 2, invalid: 2, blocked: 1 });
    expect(preview.rows[0]).toMatchObject({ tags: ["billing", "finance"], pinned: true });
    // The secret never comes back.
    expect(JSON.stringify(r.json)).not.toContain(AWS);
    // Preview stores nothing.
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM semantic_memory_items WHERE scope = 'team'`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("is for curators: a steward may, a member may not", async () => {
    const body = { scope: "team", format: "csv", content: "statement,kind\nA steward row,fact\n" };
    expect((await as.steward.post(PREVIEW, body)).status).toBe(200);
    expect(errorOf(await as.member.post(PREVIEW, body))).toEqual([403, "memory_not_allowed"]);
  });

  it("refuses an unreadable or oversized file whole", async () => {
    expect(
      errorOf(await as.admin.post(PREVIEW, { scope: "team", format: "json", content: "{" })),
    ).toEqual([400, "memory_import_invalid"]);
    const many = `statement,kind\n${"Row,fact\n".repeat(1001)}`;
    expect(
      errorOf(await as.admin.post(PREVIEW, { scope: "team", format: "csv", content: many })),
    ).toEqual([413, "memory_import_too_large"]);
  });
});

describe("import commit (ac-2)", () => {
  it("saves only the accepted clean rows, as imports, and audits counts", async () => {
    const stale = await as.admin.post(COMMIT, {
      scope: "team",
      format: "csv",
      content: SEEDED,
      accept: [0, 4],
    });
    expect(errorOf(stale)).toEqual([409, "memory_import_stale"]);
    expect(semanticMemoryErrorSchema.parse(stale.json).import_rows).toEqual([4]);

    const r = await as.admin.post(COMMIT, {
      scope: "team",
      format: "csv",
      content: SEEDED,
      accept: [0],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = semanticMemoryImportCommitResponseSchema.parse(r.json);
    expect(done.created).toBe(1);
    const saved = semanticMemoryItemDetailSchema.parse(
      (await as.member.get(`${ITEMS}/team/${done.item_ids[0]}`)).json,
    );
    expect(saved).toMatchObject({
      statement: "Invoices are approved by the finance lead.",
      pinned: true,
      tags: ["billing", "finance"],
    });
    expect(saved.versions[0]).toMatchObject({ actor_kind: "import", lint_override: false });
    expect(await auditOf("memory.items.imported")).toContainEqual({
      team_id: teamA,
      actor_id: ids.admin,
      target: { scope: "team", format: "csv", created: 1, skipped: 6 },
    });
    // The same file again: row 0 became a near-duplicate of what was just saved, so it is stale
    // unless the curator saves it anyway (overrides.lint, recorded on the version).
    const commitRow0 = (extra: Record<string, unknown> = {}) =>
      as.admin.post(COMMIT, {
        scope: "team",
        format: "csv",
        content: SEEDED,
        accept: [0],
        ...extra,
      });
    expect(errorOf(await commitRow0())).toEqual([409, "memory_import_stale"]);
    const anyway = await commitRow0({ overrides: { lint: true } });
    expect(anyway.status, JSON.stringify(anyway.json)).toBe(200);
    const [copy] = semanticMemoryImportCommitResponseSchema.parse(anyway.json).item_ids;
    const copied = semanticMemoryItemDetailSchema.parse(
      (await as.admin.get(`${ITEMS}/team/${copy}`)).json,
    );
    expect(copied.versions[0]).toMatchObject({ actor_kind: "import", lint_override: true });
    // Archive it again so later files see one copy.
    await as.admin.post(`${ITEMS}/team/${copy}/archive`, {});
  });
});

describe("Policy rows and the Site (ac-3)", () => {
  const POLICY_FILE = JSON.stringify({
    format: "kobe.memory.v1",
    items: [
      { kind: "fact", statement: "Customer data stays in the EU region.", policy: true },
      { kind: "fact", statement: "The site wiki lives at the intranet." },
    ],
  });

  it("lets only Site admins import Policy; Site stewards import the rest", async () => {
    const body = { scope: "site", format: "json", content: POLICY_FILE };
    const steward = semanticMemoryImportPreviewResponseSchema.parse(
      (await as.siteSteward.post(PREVIEW, body)).json,
    );
    expect(steward.rows.map((r) => [r.status, r.issues.map((i) => i.code)])).toEqual([
      ["invalid", ["policy_not_allowed"]],
      ["new", []],
    ]);
    expect(errorOf(await as.siteSteward.post(COMMIT, { ...body, accept: [0] }))).toEqual([
      409,
      "memory_import_stale",
    ]);
    const r = await as.site.post(COMMIT, { ...body, accept: [0, 1] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const [policyId] = semanticMemoryImportCommitResponseSchema.parse(r.json).item_ids;
    const policy = semanticMemoryItemDetailSchema.parse(
      (await as.site.get(`${ITEMS}/site/${policyId}`)).json,
    );
    expect(policy.policy).toBe(true);
    expect(errorOf(await as.admin.post(PREVIEW, body))).toEqual([403, "memory_not_allowed"]);
  });
});

describe("export (ac-3)", () => {
  it("exports a scope as JSON or CSV for curators, audited; members may not", async () => {
    const json = await as.steward.get("/v1/memory/semantic/export?scope=team");
    expect(json.status, json.text).toBe(200);
    const doc = semanticMemoryExportDocumentSchema.parse(json.json);
    expect(doc.items.map((i) => i.statement)).toContain(
      "Invoices are approved by the finance lead.",
    );
    expect(json.headers.get("content-disposition")).toMatch(
      /attachment; filename="kobe-memories-team-/,
    );

    const csv = await as.site.get("/v1/memory/semantic/export?scope=site&format=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.text.split("\r\n")[0]).toBe(
      "ref,kind,statement,tags,pinned,as_of,policy,status,superseded_by",
    );

    expect(errorOf(await as.member.get("/v1/memory/semantic/export?scope=team"))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    const exported = await auditOf("memory.items.exported");
    expect(exported).toContainEqual({
      team_id: teamA,
      actor_id: ids.steward,
      target: { scope: "team", format: "json", count: doc.items.length, includeInactive: false },
    });
    expect(exported).toContainEqual(expect.objectContaining({ team_id: null, actor_id: ids.site }));
  });

  it("re-imports an export as it was", async () => {
    const doc = (await as.admin.get("/v1/memory/semantic/export?scope=team")).json;
    const r = await as.admin.post(PREVIEW, {
      scope: "team",
      format: "json",
      content: JSON.stringify(doc),
    });
    const preview = semanticMemoryImportPreviewResponseSchema.parse(r.json);
    // Everything in it is already saved: every row is a near-duplicate.
    expect(new Set(preview.rows.map((row) => row.status))).toEqual(new Set(["duplicate"]));
  });
});

describe("curation ignores the curator's active Workspace switches (coordinator 2026-11-13)", () => {
  it("a Site admin whose Workspace has Site memories off still manages every Site item", async () => {
    const off = await as.admin.put("/v1/memory/settings?level=team", {
      site_memories_enabled: false,
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    try {
      // Members of that Workspace now see Policy only.
      const memberList = await as.member.get(`${ITEMS}?scope=site`);
      expect(memberList.status).toBe(200);
      const seen = (memberList.json as { items: { policy: boolean }[] }).items;
      expect(seen.every((i) => i.policy)).toBe(true);

      const made = await as.site.post(ITEMS, {
        scope: "site",
        kind: "fact",
        statement: `Curated while switched off ${randomUUID()}`,
      });
      expect(made.status, JSON.stringify(made.json)).toBe(201);
      const item = semanticMemoryItemDetailSchema.parse(made.json);
      const list = await as.site.get(`${ITEMS}?scope=site&policy=false`);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.json)).toContain(item.id);
      const path = `${ITEMS}/site/${item.id}`;
      expect((await as.site.patch(path, { expected_version: 1, tags: ["ops"] })).status).toBe(200);
      expect(
        (await as.site.post(`${path}/pin`, { pinned: true, expected_version: 1 })).status,
      ).toBe(200);
      expect(
        (await as.site.post(`${path}/pin`, { pinned: false, expected_version: 1 })).status,
      ).toBe(200);
      expect((await as.site.patch(path, { expected_version: 1, policy: true })).status).toBe(200);
      expect((await as.site.patch(path, { expected_version: 1, policy: false })).status).toBe(200);
      expect((await as.site.post(`${path}/archive`, {})).status).toBe(200);
      expect((await as.site.post(`${path}/restore`, {})).status).toBe(200);
      // A Site steward too; import and export as well.
      const file = {
        scope: "site",
        format: "csv",
        content: `statement,kind\nSteward row ${randomUUID()},fact\n`,
      };
      expect((await as.siteSteward.post(PREVIEW, file)).status).toBe(200);
      expect((await as.siteSteward.post(COMMIT, { ...file, accept: [0] })).status).toBe(200);
      expect((await as.site.get("/v1/memory/semantic/export?scope=site")).status).toBe(200);
      // A Team admin's Workspace items aren't blocked by the Workspace's Site memories switch.
      expect((await as.admin.get(`${ITEMS}?scope=team`)).status).toBe(200);
    } finally {
      await as.admin.put("/v1/memory/settings?level=team", { site_memories_enabled: true });
    }
  });
});
