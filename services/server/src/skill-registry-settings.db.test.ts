import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registryReady } from "./skills/registry/settings.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-330 (SK20, SK21): the Registry settings. Site admins read the spec's defaults on a fresh
 * Site, change any subset with validation (an existing Registry team, a catalog judge alias, rule
 * ranges), and every change is audited; members are refused. The Registry is not ready (Approve is
 * refused) until a Registry team is named, and again when it is cleared or the team is deleted.
 */
let h: Harness;
const registry = randomUUID();
const ids = { admin: "", member: "" };
const as = {} as Record<"admin" | "member", TestBrowser>;
const PATH = "/v1/site/skills/registry/settings";

beforeAll(async () => {
  h = await openHarness();
  ids.admin = await h.createUser("admin@registry.test", "admin");
  ids.member = await h.createUser("member@registry.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'registry', 'Registry')`, [
    registry,
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
  });

  it("refuses members and bad values (ac-1)", async () => {
    expect((await as.member.get(PATH)).status).toBe(403);
    expect((await as.member.put(PATH, { judgeAlias: "smart" })).status).toBe(403);
    for (const bad of [
      {},
      { registryTeamId: "nope" },
      { submissionRules: { minPassRate: 2 } },
      { importAllowlist: ["https://github.com"] },
      { mirror: { enabled: true } },
      { evalLimits: { maxCases: 99 } },
      { surprise: true },
    ]) {
      expect((await as.admin.put(PATH, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const team = await as.admin.put(PATH, { registryTeamId: randomUUID() });
    expect([team.status, team.json.code]).toEqual([400, "unknown_team"]);
    const alias = await as.admin.put(PATH, { judgeAlias: "nobody" });
    expect([alias.status, alias.json.code]).toEqual([400, "unknown_alias"]);
    expect(await audits()).toEqual([]);
  });

  it("persists a change with validation and audits it; the Registry becomes ready (ac-1, ac-2)", async () => {
    const res = await as.admin.put(PATH, {
      registryTeamId: registry,
      judgeAlias: "smart",
      submissionRules: { minCases: 5, minNegativeCases: 2, minPassRate: 0.9 },
      importAllowlist: ["github.com"],
      scanner: { external: true },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({
      ready: true,
      registryTeam: { id: registry, slug: "registry", name: "Registry" },
      judgeAlias: "smart",
      submissionRules: { minCases: 5, minNegativeCases: 2, minPassRate: 0.9, minLift: 0 },
      importAllowlist: ["github.com"],
      scanner: { external: true },
    });
    expect((await as.admin.get(PATH)).json).toMatchObject({ ready: true, judgeAlias: "smart" });
    expect(await registryReady(h.deps.database.db)).toBe(true);
    expect(await audits()).toEqual([
      {
        actor_id: ids.admin,
        target: {
          changed: [
            "registryTeamId",
            "judgeAlias",
            "submissionRules",
            "importAllowlist",
            "scanner",
          ],
          registryTeamId: registry,
          judgeAlias: "smart",
        },
      },
    ]);
  });

  it("is not ready again when the team is cleared or deleted", async () => {
    const cleared = await as.admin.put(PATH, { registryTeamId: null });
    expect(cleared.json).toMatchObject({ ready: false, registryTeam: null });
    expect((await as.admin.put(PATH, { registryTeamId: registry })).json.ready).toBe(true);
    await h.admin.query(`DELETE FROM teams WHERE id = $1`, [registry]);
    expect(await registryReady(h.deps.database.db)).toBe(false);
    expect((await as.admin.get(PATH)).json).toMatchObject({ ready: false, registryTeam: null });
  });
});
