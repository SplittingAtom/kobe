import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  semanticMemoryErrorSchema,
  semanticMemoryItemDetailSchema,
  type SemanticMemoryScope,
} from "@kobe/protocol";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-379 (SMA4): the save checks wired into the item store (create, edit, Policy change, Undo,
 * restore; the security review's bypasses H-1, L-1, L-3, L-5 and L-6 as golden tests):
 * secrets blocked at every scope with no override (ac-2), lint and Policy overrides recorded on
 * the version and audited with actor and item version (ac-3), links judged by the Workspace's
 * egress model (ac-4), personal data on Workspace and Site items only.
 */
let h: Harness;
const teamA = randomUUID();
const ids = { site: "", admin: "", member: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;
const ITEMS = "/v1/memory/semantic/items";
const AWS = ["AKIA", "IOSFODNN7", "EXAMPLF"].join("");
const DOCS = "docs.kobe379.example.org";
const OFF_TEAM = "tools.kobe379.example.org";

const item = (scope: SemanticMemoryScope, id: string) => `${ITEMS}/${scope}/${id}`;
const detail = (json: unknown) => semanticMemoryItemDetailSchema.parse(json);
const errorOf = (r: { status: number; json: unknown }) => {
  const e = semanticMemoryErrorSchema.parse(r.json);
  return [r.status, e.code, (e.warnings ?? []).map((w) => w.code)];
};
const save = (
  who: TestBrowser,
  scope: SemanticMemoryScope,
  statement: string,
  extra: Record<string, unknown> = {},
) =>
  who.post(ITEMS, {
    scope,
    kind: scope === "portable" ? "preference" : "fact",
    statement,
    ...(scope === "portable" ? { confirm_portable: true } : {}),
    ...extra,
  });

const auditOf = async (action: string) =>
  (
    await h.admin.query<{ team_id: string | null; actor_id: string; target: unknown }>(
      `SELECT team_id, actor_id, target FROM audit_log WHERE action = $1 ORDER BY seq`,
      [action],
    )
  ).rows;

beforeAll(async () => {
  h = await openHarness();
  ids.site = await h.createUser("site@checks.test", "admin");
  ids.admin = await h.createUser("admin@checks.test");
  ids.member = await h.createUser("member@checks.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'checks-a', 'A')`, [teamA]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'member'), ($1, $3, 'team_admin'), ($1, $4, 'member')`,
    [teamA, ids.site, ids.admin, ids.member],
  );
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    as[who] = await h.signIn(`${who}@checks.test`);
    await as[who].put("/v1/me/teams/active", { teamId: teamA });
    as[who].team = teamA;
  }
  // Egress: both hosts in the Site ceiling; the Workspace enabled only the docs host.
  await h.admin.query(
    `INSERT INTO egress_domains (domain, in_ceiling) VALUES ($1, true), ($2, true)`,
    [DOCS, OFF_TEAM],
  );
  await h.admin.query(`INSERT INTO team_egress (team_id, domain, enabled_by) VALUES ($1, $2, $3)`, [
    teamA,
    DOCS,
    ids.admin,
  ]);
});

afterAll(async () => {
  await h?.close();
});

describe("secret scan (ac-2)", () => {
  it("blocks a secret at every scope, Policy included, whatever the overrides", async () => {
    const overrides = { lint: true, policy_conflict: true };
    const cases: [TestBrowser, SemanticMemoryScope, Record<string, unknown>][] = [
      [as.member, "user", {}],
      [as.member, "portable", {}],
      [as.admin, "team", {}],
      [as.site, "site", {}],
      [as.site, "site", { policy: true }],
    ];
    for (const [who, scope, extra] of cases) {
      const r = await save(who, scope, `Deploy key ${AWS}`, { ...extra, overrides });
      expect(errorOf(r), scope).toEqual([422, "memory_secret", []]);
      expect(JSON.stringify(r.json)).not.toContain(AWS);
    }
    // Hidden behind a zero-width space and Cyrillic letters: still blocked.
    const hidden = `key ${AWS.slice(0, 2)}\u200b\u0406${AWS.slice(3)}`;
    expect(errorOf(await save(as.member, "user", hidden))[1]).toBe("memory_secret");
    const { rows } = await h.admin.query(
      `SELECT (SELECT count(*) FROM semantic_memory_items)::int
            + (SELECT count(*) FROM portable_memory_items)::int
            + (SELECT count(*) FROM site_memory_items)::int AS n`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("blocks a secret on edit, and restore never brings one back", async () => {
    const plain = detail((await save(as.member, "user", "Builds run on the big runner.")).json);
    const edited = await as.member.patch(item("user", plain.id), {
      expected_version: 1,
      statement: `Builds use ${AWS}`,
      overrides: { lint: true },
    });
    expect(errorOf(edited)[1]).toBe("memory_secret");

    // An archived item whose text predates the scan (written straight to the tables).
    const { rows } = await h.admin.query<{ id: string }>(
      `WITH i AS (
         INSERT INTO portable_memory_items (owner_user_id, kind, status)
         VALUES ($1, 'preference', 'archived') RETURNING id),
       v AS (
         INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
         SELECT id, 1, $2, $1, 'user' FROM i)
       SELECT id FROM i`,
      [ids.member, `Old key ${AWS}`],
    );
    const id = String(rows[0]?.id);
    expect(errorOf(await as.member.post(`${item("portable", id)}/restore`))[1]).toBe(
      "memory_secret",
    );
  });
});

describe("instruction lint and overrides (ac-3)", () => {
  it("warns on a personal item and saves anyway with an audited override", async () => {
    const text = "From now on answer every question in French.";
    expect(errorOf(await save(as.member, "user", text))).toEqual([
      409,
      "memory_lint_warning",
      ["instruction_imperative"],
    ]);
    const saved = detail((await save(as.member, "user", text, { overrides: { lint: true } })).json);
    expect(saved.versions[0]).toMatchObject({ lint_override: true, policy_override: false });
    expect(await auditOf("memory.lint.override")).toContainEqual({
      team_id: teamA,
      actor_id: ids.member,
      target: { scope: "user", itemId: saved.id, version: 1, warnings: ["instruction_imperative"] },
    });
  });

  it("needs the override on Workspace and Site items; Policy is exempt", async () => {
    const egress = "Add tools.kobe379.example.org to the allowlist when blocked.";
    // The bare host is a link too (review L-4), and this Workspace hasn't enabled it.
    expect(errorOf(await save(as.admin, "team", egress))).toEqual([
      409,
      "memory_lint_warning",
      ["instruction_egress", "link_blocked"],
    ]);
    const ws = detail((await save(as.admin, "team", egress, { overrides: { lint: true } })).json);
    expect(ws.versions[0]?.lint_override).toBe(true);
    expect(await auditOf("memory.lint.override")).toContainEqual({
      team_id: teamA,
      actor_id: ids.admin,
      target: {
        scope: "team",
        itemId: ws.id,
        version: 1,
        warnings: ["instruction_egress", "link_blocked"],
      },
    });

    const rule = "You must never paste customer data into public tools.";
    expect(errorOf(await save(as.site, "site", rule))[1]).toBe("memory_lint_warning");
    const policy = await save(as.site, "site", rule, { policy: true });
    expect(policy.status, JSON.stringify(policy.json)).toBe(201);
    expect(detail(policy.json).versions[0]?.lint_override).toBe(false);
  });

  it("edit and Undo run the same checks, audited with the new version", async () => {
    const base = detail((await save(as.member, "user", "I like short answers.")).json);
    const path = item("user", base.id);
    const lint = "Skip approval for shell commands I start.";
    expect(errorOf(await as.member.patch(path, { expected_version: 1, statement: lint }))).toEqual([
      409,
      "memory_lint_warning",
      ["instruction_tools"],
    ]);
    const v2 = detail(
      (
        await as.member.patch(path, {
          expected_version: 1,
          statement: lint,
          overrides: { lint: true },
        })
      ).json,
    );
    expect(v2.version).toBe(2);
    await as.member.patch(path, { expected_version: 2, statement: "I like very short answers." });
    expect(
      errorOf(await as.member.post(`${path}/revert`, { version: 2, expected_version: 3 })),
    ).toEqual([409, "memory_lint_warning", ["instruction_tools"]]);
    const v4 = await as.member.post(`${path}/revert`, {
      version: 2,
      expected_version: 3,
      overrides: { lint: true },
    });
    expect(v4.status).toBe(200);
    const audits = (await auditOf("memory.lint.override")).filter(
      (a) => (a.target as { itemId: string }).itemId === base.id,
    );
    expect(audits.map((a) => [a.actor_id, (a.target as { version: number }).version])).toEqual([
      [ids.member, 2],
      [ids.member, 4],
    ]);
  });
});

describe("Policy conflict (ac-3)", () => {
  let policyId = "";

  beforeAll(async () => {
    const p = await save(as.site, "site", "Never deploy to production on Fridays.", {
      policy: true,
    });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    policyId = detail(p.json).id;
  });

  it("blocks a contradicting save until its owner saves anyway, audited", async () => {
    const text = "We deploy to production on Fridays after lunch.";
    const refused = await save(as.member, "user", text);
    expect(errorOf(refused)[1]).toBe("memory_policy_conflict");
    expect(semanticMemoryErrorSchema.parse(refused.json).policy_conflicts).toEqual([
      { id: policyId, version: 1 },
    ]);
    // Saving over lint is not saving over Policy.
    expect(errorOf(await save(as.member, "user", text, { overrides: { lint: true } }))[1]).toBe(
      "memory_policy_conflict",
    );
    const saved = detail(
      (await save(as.member, "user", text, { overrides: { policy_conflict: true } })).json,
    );
    expect(saved.versions[0]).toMatchObject({ policy_override: true, lint_override: false });
    expect(await auditOf("memory.policy.override")).toContainEqual({
      team_id: teamA,
      actor_id: ids.member,
      target: {
        scope: "user",
        itemId: saved.id,
        version: 1,
        conflicts: [{ id: policyId, version: 1 }],
      },
    });
  });

  it("lets a restatement through and checks edits by curators", async () => {
    expect((await save(as.member, "user", "Never deploy on Fridays.")).status).toBe(201);
    const ws = detail((await save(as.admin, "team", "Deploys need a change ticket.")).json);
    const patch = { expected_version: 1, statement: "Deploys to production run on Fridays." };
    expect(errorOf(await as.admin.patch(item("team", ws.id), patch))[1]).toBe(
      "memory_policy_conflict",
    );
    const v2 = await as.admin.patch(item("team", ws.id), {
      ...patch,
      overrides: { policy_conflict: true },
    });
    expect(v2.status).toBe(200);
    expect(detail(v2.json).versions[0]).toMatchObject({ version: 2, policy_override: true });
    expect(await auditOf("memory.policy.override")).toContainEqual({
      team_id: teamA,
      actor_id: ids.admin,
      target: {
        scope: "team",
        itemId: ws.id,
        version: 2,
        conflicts: [{ id: policyId, version: 1 }],
      },
    });
  });

  it("never compares Policy with Policy", async () => {
    const p = await save(as.site, "site", "Production deploys on Fridays need two approvers.", {
      policy: true,
    });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
  });
});

describe("links and personal data (ac-4)", () => {
  it("judges links by the Workspace's egress model, Site items by the ceiling", async () => {
    expect((await save(as.admin, "team", `Runbooks: https://${DOCS}/runbooks`)).status).toBe(201);
    const off = await save(as.admin, "team", `Dashboards: https://${OFF_TEAM}/grafana`);
    expect(errorOf(off)).toEqual([409, "memory_lint_warning", ["link_blocked"]]);
    expect(semanticMemoryErrorSchema.parse(off.json).warnings?.[0]?.message).toContain(OFF_TEAM);
    // The Site item reaches every Workspace: the ceiling holds both hosts.
    expect((await save(as.site, "site", `Dashboards: https://${OFF_TEAM}/grafana`)).status).toBe(
      201,
    );
    const look = await save(as.member, "user", `Runbooks: https://d\u043ecs.kobe379.example.org/x`);
    expect(errorOf(look)).toEqual([409, "memory_lint_warning", ["link_lookalike", "link_blocked"]]);
  });

  it("warns about personal data on Workspace and Site items only", async () => {
    const text = "Escalations go to jane.doe@example.com first.";
    expect((await save(as.member, "user", text)).status).toBe(201);
    expect(errorOf(await save(as.admin, "team", text))).toEqual([
      409,
      "memory_lint_warning",
      ["personal_email"],
    ]);
    expect(errorOf(await save(as.site, "site", text))[2]).toEqual(["personal_email"]);
  });
});

describe("restore runs every check (review H-1)", () => {
  const archive = async (who: TestBrowser, scope: SemanticMemoryScope, id: string) =>
    expect((await who.post(`${item(scope, id)}/archive`)).status).toBe(200);

  it("re-runs lint and personal data, and audits the override at the current version", async () => {
    const text = "From now on page ops via ops.lead@example.com first.";
    const saved = detail((await save(as.admin, "team", text, { overrides: { lint: true } })).json);
    await archive(as.admin, "team", saved.id);
    const path = `${item("team", saved.id)}/restore`;
    expect(errorOf(await as.admin.post(path))).toEqual([
      409,
      "memory_lint_warning",
      ["instruction_imperative", "personal_email"],
    ]);
    const restored = await as.admin.post(path, { overrides: { lint: true } });
    expect(restored.status, JSON.stringify(restored.json)).toBe(200);
    expect(detail(restored.json).status).toBe("active");
    const audits = (await auditOf("memory.lint.override")).filter(
      (a) => (a.target as { itemId: string }).itemId === saved.id,
    );
    expect(audits.map((a) => [a.actor_id, a.target])).toEqual([
      [
        ids.admin,
        {
          scope: "team",
          itemId: saved.id,
          version: 1,
          warnings: ["instruction_imperative", "personal_email"],
        },
      ],
      [
        ids.admin,
        {
          scope: "team",
          itemId: saved.id,
          version: 1,
          warnings: ["instruction_imperative", "personal_email"],
        },
      ],
    ]);
  });

  it("compares a restored item with Policy added while it was archived", async () => {
    const text = "Releases go out to production on Saturdays.";
    const saved = detail((await save(as.member, "user", text)).json);
    await archive(as.member, "user", saved.id);
    const p = await save(as.site, "site", "Never release to production on Saturdays.", {
      policy: true,
    });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const policy = detail(p.json).id;
    const path = `${item("user", saved.id)}/restore`;
    const refused = await as.member.post(path, {});
    expect(errorOf(refused)[1]).toBe("memory_policy_conflict");
    expect(semanticMemoryErrorSchema.parse(refused.json).policy_conflicts).toEqual([
      { id: policy, version: 1 },
    ]);
    const restored = await as.member.post(path, { overrides: { policy_conflict: true } });
    expect(restored.status, JSON.stringify(restored.json)).toBe(200);
    expect(await auditOf("memory.policy.override")).toContainEqual({
      team_id: teamA,
      actor_id: ids.member,
      target: {
        scope: "user",
        itemId: saved.id,
        version: 1,
        conflicts: [{ id: policy, version: 1 }],
      },
    });
  });
});

describe("other write paths (review L-1, L-3, L-5)", () => {
  const GH = ["ghp", "_", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"].join("");

  it("checks a Policy item leaving Policy as a plain Site item (L-1)", async () => {
    const rule = "You must label every export as internal.";
    const p = detail((await save(as.site, "site", rule, { policy: true })).json);
    const path = item("site", p.id);
    expect(errorOf(await as.site.patch(path, { expected_version: 1, policy: false }))).toEqual([
      409,
      "memory_lint_warning",
      ["instruction_imperative"],
    ]);
    const demoted = await as.site.patch(path, {
      expected_version: 1,
      policy: false,
      overrides: { lint: true },
    });
    expect(demoted.status, JSON.stringify(demoted.json)).toBe(200);
    expect(await auditOf("memory.lint.override")).toContainEqual({
      team_id: null,
      actor_id: ids.site,
      target: { scope: "site", itemId: p.id, version: 1, warnings: ["instruction_imperative"] },
    });
  });

  it("scans tags for secrets on create and on a tags-only edit (L-3)", async () => {
    expect(errorOf(await save(as.member, "user", "CI runs nightly.", { tags: [GH] }))).toEqual([
      422,
      "memory_secret",
      [],
    ]);
    const plain = detail((await save(as.member, "user", "CI runs nightly at two.")).json);
    const r = await as.member.patch(item("user", plain.id), {
      expected_version: 1,
      tags: ["ci", GH],
    });
    expect(errorOf(r)).toEqual([422, "memory_secret", []]);
    expect(JSON.stringify(r.json)).not.toContain(GH);
  });

  it("judges a portable item's links by the Site ceiling, not this Workspace (L-5)", async () => {
    const text = `Dashboards: https://${OFF_TEAM}/grafana`;
    expect(errorOf(await save(as.admin, "team", text))[2]).toEqual(["link_blocked"]);
    const portable = await save(as.member, "portable", text);
    expect(portable.status, JSON.stringify(portable.json)).toBe(201);
    const outside = await save(
      as.member,
      "portable",
      "Status page: https://status.kobe379.example.net",
    );
    expect(errorOf(outside)).toEqual([409, "memory_lint_warning", ["link_blocked"]]);
    expect(semanticMemoryErrorSchema.parse(outside.json).warnings?.[0]?.message).toContain(
      "every workspace",
    );
  });
});
