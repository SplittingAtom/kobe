import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registryReady, requireRegistryTeam } from "./skills/registry/settings.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-330 (SK20, SK21) and its review: the Registry settings. Site admins read the spec's defaults
 * on a fresh Site and change any subset with validation (a catalog judge alias, rule ranges, a
 * mirror URL without credentials); only real changes are audited; members are refused. The
 * Registry team is always the dedicated one Kobe creates: an existing team is never named (API or
 * database). The Registry is not ready (the guard answers registry_not_ready) until it exists.
 */
let h: Harness;
const existing = randomUUID();
const ids = { admin: "", member: "" };
const as = {} as Record<"admin" | "member", TestBrowser>;
const PATH = "/v1/site/skills/registry/settings";
const TEAM = "/v1/site/skills/registry/team";

beforeAll(async () => {
  h = await openHarness();
  ids.admin = await h.createUser("admin@registry.test", "admin");
  ids.member = await h.createUser("member@registry.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance')`, [
    existing,
  ]);
  await h.admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('anthropic', 'anthropic', 'anthropic', 'v2.test.sealed-provider-key', $1)`,
    [ids.admin],
  );
  await h.admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by) VALUES ('smart', 'anthropic', 'claude-smart', $1)`,
    [ids.admin],
  );
  as.admin = await h.signIn("admin@registry.test");
  as.member = await h.signIn("member@registry.test");
});

afterAll(async () => {
  await h?.close();
});

const audits = async () =>
  (
    await h.admin.query<{ target: Record<string, unknown>; actor_id: string }>(
      `SELECT target, actor_id FROM audit_log WHERE action = 'skill.registry.settings_updated' ORDER BY seq`,
    )
  ).rows;

describe("Registry settings (KOBE-330)", () => {
  it("reads the spec's defaults on a fresh Site, not ready (ac-2, ac-3)", async () => {
    const res = await as.admin.get(PATH);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ready: false,
      registryTeam: null,
      judgeAlias: null,
      submissionRules: {
        minCases: 3,
        minNegativeCases: 1,
        minPassRate: 0.8,
        minLift: 0,
        minTriggerPrecision: 0.8,
        refuseBlockVerdict: true,
        requireLicense: true,
        requireFreshScorecard: true,
        retriesPerFailingCase: 1,
      },
      evalLimits: { maxConcurrentSandboxes: 4, maxCases: 25, caseWallClockMinutes: 10 },
      importAllowlist: [],
      scanner: { external: false },
      mirror: { enabled: false },
    });
    expect(await registryReady(h.deps.database.db)).toBe(false);
    // The guard Approve and re-runs call (KOBE-333 onward) answers registry_not_ready.
    expect(await requireRegistryTeam(h.deps.database.db)).toEqual({
      ok: false,
      code: "registry_not_ready",
    });
  });

  it("refuses members and bad values, a mirror URL with credentials too (ac-1)", async () => {
    expect((await as.member.get(PATH)).status).toBe(403);
    expect((await as.member.put(PATH, { judgeAlias: "smart" })).status).toBe(403);
    expect((await as.member.post(TEAM, { name: "R", slug: "r" })).status).toBe(403);
    for (const bad of [
      {},
      { submissionRules: { minPassRate: 2 } },
      { importAllowlist: ["https://github.com"] },
      { mirror: { enabled: true } },
      { mirror: { enabled: true, url: "https://bot:token@git.example.org/c.git" } },
      { evalLimits: { maxCases: 99 } },
      { surprise: true },
    ]) {
      expect((await as.admin.put(PATH, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const alias = await as.admin.put(PATH, { judgeAlias: "nobody" });
    expect([alias.status, alias.json.code]).toEqual([400, "unknown_alias"]);
    expect(await audits()).toEqual([]);
  });

  it("never names an existing team: not through the API, not in the database (review H1)", async () => {
    const named = await as.admin.put(PATH, { registryTeamId: existing });
    expect(named.status).toBe(400);
    await expect(
      h.admin.query(`UPDATE site_skill_settings SET registry_team_id = $1 WHERE id = 1`, [
        existing,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await as.admin.get(PATH)).json.ready).toBe(false);
  });

  it("persists changes with validation and audits only what changed (ac-1, review L2)", async () => {
    const body = {
      judgeAlias: "smart",
      submissionRules: { minCases: 5, minNegativeCases: 2, minPassRate: 0.9 },
      importAllowlist: ["github.com"],
      scanner: { external: true },
    };
    const res = await as.admin.put(PATH, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({
      judgeAlias: "smart",
      submissionRules: { minCases: 5, minNegativeCases: 2, minPassRate: 0.9, minLift: 0 },
      importAllowlist: ["github.com"],
      scanner: { external: true },
    });
    // The same values again change nothing and record nothing.
    expect((await as.admin.put(PATH, body)).status).toBe(200);
    expect(await audits()).toEqual([
      {
        actor_id: ids.admin,
        target: {
          changed: ["judgeAlias", "submissionRules", "importAllowlist", "scanner"],
          judgeAlias: "smart",
        },
      },
    ]);
  });

  it("creates the dedicated Registry team once, which makes the Registry ready (ac-2, review H1)", async () => {
    const made = await as.admin.post(TEAM, { name: "Skill Registry", slug: "skill-registry" });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect(made.json).toMatchObject({
      ready: true,
      registryTeam: { slug: "skill-registry", name: "Skill Registry" },
    });
    const teamId = made.json.registryTeam.id as string;
    const team = await h.admin.query(`SELECT registry FROM teams WHERE id = $1`, [teamId]);
    expect(team.rows).toEqual([{ registry: true }]);
    const admin = await h.admin.query(
      `SELECT user_id, role, added_via FROM team_members WHERE team_id = $1`,
      [teamId],
    );
    expect(admin.rows).toEqual([{ user_id: ids.admin, role: "team_admin", added_via: null }]);
    expect(await requireRegistryTeam(h.deps.database.db)).toEqual({ ok: true, teamId });
    const again = await as.admin.post(TEAM, { name: "Two", slug: "two" });
    expect([again.status, again.json.code]).toEqual([409, "registry_exists"]);
    // Deleting the team leaves the Registry not ready; a new one can be created.
    await h.admin.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
    expect(await registryReady(h.deps.database.db)).toBe(false);
    const taken = await as.admin.post(TEAM, { name: "Finance", slug: "finance" });
    expect([taken.status, taken.json.code]).toEqual([409, "slug_taken"]);
    expect((await as.admin.post(TEAM, { name: "Registry 2", slug: "registry-2" })).status).toBe(
      201,
    );
  });
});
