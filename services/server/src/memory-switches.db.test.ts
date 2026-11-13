import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { learningModelFor } from "./memory/learning-model.js";
import { MEMORY_SITE_SETTINGS_KEY } from "./memory/site-settings.js";
import { buildRunMemory } from "./memory/agent.js";
import { SITE_SWITCH_KEYS, readSwitches, semanticRunLanes } from "./memory/switches.js";

/**
 * KOBE-381: `/v1/memory/settings` with the v1.3 switches (master widening, Memories, Workspace
 * and Site memories, Portable preferences, Learn, Site proposals), the Site memory settings, the
 * learning model (judge pattern, no fallback) and "off deletes nothing", end to end.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };

beforeAll(async () => {
  await fx.setup([{}], () => ({ blobs }));
});
afterAll(() => fx.teardown());

/** Site switches and settings are site-wide: every test leaves them at their defaults. */
afterEach(async () => {
  await fx.admin.query(`DELETE FROM site_settings WHERE key = ANY($1)`, [
    [...Object.values(SITE_SWITCH_KEYS), MEMORY_SITE_SETTINGS_KEY],
  ]);
});

let n = 0;
async function world() {
  const admin = await fx.person(`sw-adm${n++}`);
  const member = await fx.person(`sw-mem${n}`);
  const team = await fx.team(`t-sw-${n}`, admin, [member]);
  return { admin, member, team };
}

async function siteAdmin(): Promise<Person> {
  const email = `sw-ia${n++}-${randomUUID().slice(0, 6)}@events.test`;
  await fx
    .replica(0)
    .deps.createUserWithPassword(
      { email, name: "ia", password: "a long enough password" },
      { siteRole: "admin" },
    );
  const b = new TestBrowser(fx.replica(0).app, PUBLIC_URL);
  const res = await b.post("/api/auth/sign-in/email", {
    email,
    password: "a long enough password",
  });
  expect(res.status).toBe(200);
  return { browser: b } as Person;
}

const settings = (p: Person, level: string, body?: object) =>
  body
    ? p.browser.put(`/v1/memory/settings?level=${level}`, body)
    : p.browser.get(`/v1/memory/settings?level=${level}`);

const WS_ON = {
  memory_enabled: true,
  project_memory_enabled: true,
  memories_enabled: true,
  workspace_memories_enabled: true,
  site_memories_enabled: true,
  learn_enabled: true,
  site_proposals_enabled: true,
  learning_model_alias: null,
};

async function catalogModel(alias: string, by: string) {
  await fx.admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [by],
  );
  await fx.admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ($1, 'openai', $1, $2) ON CONFLICT (alias) DO NOTHING`,
    [alias, by],
  );
}
async function enable(team: string, alias: string, by: string, isDefault = false) {
  await catalogModel(alias, by);
  await fx.admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, $3, $4)`,
    [team, alias, isDefault, by],
  );
}

describe("Workspace level", () => {
  it("defaults to every switch on; team admins change any subset; audited", async () => {
    const w = await world();
    expect((await settings(w.member, "team")).json).toEqual(WS_ON);
    expect((await settings(w.member, "team", { learn_enabled: false })).status).toBe(403);
    const off = await settings(w.admin, "team", {
      site_memories_enabled: false,
      learn_enabled: false,
    });
    expect(off.status, off.text).toBe(200);
    expect(off.json).toEqual({ ...WS_ON, site_memories_enabled: false, learn_enabled: false });
    // Notes columns untouched, other keys of teams.settings kept.
    const { rows } = await fx.admin.query<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM teams WHERE id = $1`,
      [w.team],
    );
    expect(rows[0]?.settings.memory).toEqual({
      site_memories_enabled: false,
      learn_enabled: false,
    });
    const audit = await fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'memory.settings_changed'`,
      [w.team],
    );
    expect(audit.rows.map((r) => r.target)).toEqual([
      expect.objectContaining({ siteMemoriesEnabled: false, learnEnabled: false }),
    ]);
    expect((await settings(w.admin, "team", { nope: true })).status).toBe(400);
  });

  it("the learning model override must be enabled in the Workspace", async () => {
    const w = await world();
    await catalogModel("sw-off", w.admin.id);
    const refused = await settings(w.admin, "team", { learning_model_alias: "sw-off" });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ code: "model_not_enabled" });
    await enable(w.team, "sw-on", w.admin.id);
    const ok = await settings(w.admin, "team", { learning_model_alias: "sw-on" });
    expect(ok.json).toMatchObject({ learning_model_alias: "sw-on" });
    expect((await settings(w.admin, "team", { learning_model_alias: null })).json).toMatchObject({
      learning_model_alias: null,
    });
  });

  it("expected: a write against a stale before-state changes nothing (409)", async () => {
    const w = await world();
    await settings(w.admin, "team", { learn_enabled: false });
    const stale = await settings(w.admin, "team", { memory_enabled: false, expected: WS_ON });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "changed_since_approval" });
    expect((await settings(w.admin, "team")).json).toMatchObject({ memory_enabled: true });
  });
});

describe("effective (ac-1, ac-2)", () => {
  it("the master switch turns off Notes and Memories; Memories off keeps Notes", async () => {
    const w = await world();
    const eff = async () => (await settings(w.member, "effective")).json as Record<string, unknown>;
    expect(await eff()).toMatchObject({
      memory_enabled: true,
      project_memory_enabled: true,
      memories_enabled: true,
      scopes: { user: true, portable: true, team: true, site: true },
      policy: true,
      site_proposals_enabled: true,
    });
    await settings(w.admin, "team", { memories_enabled: false });
    expect(await eff()).toMatchObject({
      memory_enabled: true,
      memories_enabled: false,
      scopes: { user: false, portable: false, team: false, site: false },
      policy: true,
    });
    await settings(w.admin, "team", { memories_enabled: true, memory_enabled: false });
    expect(await eff()).toMatchObject({
      memory_enabled: false,
      project_memory_enabled: false,
      memories_enabled: false,
      scopes: { user: false, portable: false, team: false, site: false },
      // Policy is governance (Q2): a Workspace's master switch doesn't stop it.
      policy: true,
      learn: { available: false, reason: "memory_off" },
    });
    // run.start: no Notes scopes or indexes; the semantic lanes are Policy alone.
    const thread = randomUUID();
    expect(
      await buildRunMemory(
        { db: fx.db, blobs: undefined },
        {
          teamId: w.team,
          userId: w.member.id,
          threadId: thread,
        },
      ),
    ).toEqual({ scopes: [], indexes: [] });
    const { memory } = await withTeam(fx.db, w.team, (tx) => readSwitches(tx, w.team));
    expect(semanticRunLanes(memory)).toEqual(["policy"]);
  });

  it("Policy reaches a Workspace that opted out of Site memories (ac-2)", async () => {
    const w = await world();
    await settings(w.admin, "team", { site_memories_enabled: false });
    expect((await settings(w.member, "effective")).json).toMatchObject({
      scopes: { user: true, portable: true, team: true, site: false },
      policy: true,
    });
  });

  it("Site switches AND with the Workspace's and need a site admin", async () => {
    const w = await world();
    expect((await settings(w.admin, "site", { portable_enabled: false })).status).toBe(403);
    const ia = await siteAdmin();
    const saved = await settings(ia, "site", { portable_enabled: false, learn_enabled: false });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json).toMatchObject({ portable_enabled: false, learn_enabled: false });
    expect((await settings(w.member, "effective")).json).toMatchObject({
      scopes: { user: true, portable: false, team: true, site: true },
      learn: { available: false, reason: "site_learn_off" },
    });
    await settings(ia, "site", { memory_enabled: false });
    expect((await settings(w.member, "effective")).json).toMatchObject({
      memory_enabled: false,
      memories_enabled: false,
      // Only the Site's master switch stops Policy (Q2).
      policy: false,
    });
    // Notes refuse too (the master switch is the D24 one).
    const put = await w.member.browser.put("/v1/memory", {
      scope: "user",
      path: "x.md",
      content: "x",
    });
    expect(put.json).toMatchObject({ code: "memory_disabled" });
  });
});

describe("Site memory settings", () => {
  it("defaults, validated saves, unknown aliases refused, audited by name", async () => {
    const ia = await siteAdmin();
    const got = (await settings(ia, "site")).json as { settings: Record<string, unknown> };
    expect(got.settings).toMatchObject({
      context_budget_kib: 8,
      version_cap: 50,
      stale_after_days: 90,
      retention_days: 365,
      learning_model_alias: null,
    });
    expect(Object.keys(got.settings).some((k) => /lang/.test(k))).toBe(false);
    expect((await settings(ia, "site", { settings: { context_budget_kib: 17 } })).status).toBe(400);
    expect((await settings(ia, "site", { settings: { search_language: "de" } })).status).toBe(400);
    const unknown = await settings(ia, "site", {
      learn_enabled: false,
      settings: { learning_model_alias: "sw-nowhere" },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json).toMatchObject({ code: "unknown_alias" });
    // Nothing of the refused body was written.
    expect((await settings(ia, "site")).json).toMatchObject({ learn_enabled: true });
    const ok = await settings(ia, "site", {
      settings: { context_budget_kib: 12, version_cap: 20, retention_days: 400 },
    });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({
      settings: { context_budget_kib: 12, version_cap: 20, retention_days: 400 },
    });
    const { rows } = await fx.admin.query<{ target: { settings?: string[] } }>(
      `SELECT target FROM audit_log WHERE action = 'memory.site_settings_changed'
        ORDER BY seq DESC LIMIT 1`,
    );
    expect(rows[0]?.target.settings).toEqual([
      "context_budget_kib",
      "version_cap",
      "retention_days",
    ]);
  });
});

describe("learning model (ac-4)", () => {
  it("unset: unavailable with a reason, though the Workspace has a default model", async () => {
    const w = await world();
    await enable(w.team, "sw-default", w.admin.id, true);
    expect((await settings(w.member, "effective")).json).toMatchObject({
      learn: { available: false, reason: "no_learning_model" },
    });
    expect(await withTeam(fx.db, w.team, (tx) => learningModelFor(tx, w.team))).toMatchObject({
      ok: false,
      reason: "no_learning_model",
    });
  });

  it("the Workspace's model wins when set; each choice must be enabled, no fallthrough", async () => {
    const w = await world();
    const ia = await siteAdmin();
    await enable(w.team, "sw-default2", w.admin.id, true);
    await catalogModel("sw-site", w.admin.id);
    expect(
      (await settings(ia, "site", { settings: { learning_model_alias: "sw-site" } })).status,
    ).toBe(200);
    const learn = async () =>
      ((await settings(w.member, "effective")).json as { learn: unknown }).learn;
    // Site's model only, not enabled here: unavailable (the default model is never used).
    expect(await learn()).toMatchObject({
      available: false,
      reason: "learning_model_not_enabled",
    });
    await enable(w.team, "sw-site", w.admin.id);
    expect(await learn()).toMatchObject({ available: true, alias: "sw-site", source: "site" });
    // The Workspace's own model wins once set.
    await enable(w.team, "sw-ws", w.admin.id);
    await settings(w.admin, "team", { learning_model_alias: "sw-ws" });
    expect(await learn()).toMatchObject({ available: true, alias: "sw-ws", source: "team" });
    // Disabled later: unavailable, never the Site's (enabled) model or the default.
    await fx.admin.query(`DELETE FROM team_models WHERE team_id = $1 AND alias = 'sw-ws'`, [
      w.team,
    ]);
    expect(await learn()).toMatchObject({
      available: false,
      reason: "learning_model_not_enabled",
    });
  });
});

describe("review fixes (KOBE-381 review)", () => {
  const lastSiteAudit = async () =>
    (
      await fx.admin.query<{ target: Record<string, unknown> }>(
        `SELECT target FROM audit_log WHERE action = 'memory.site_settings_changed'
          ORDER BY seq DESC LIMIT 1`,
      )
    ).rows[0]?.target;
  const siteAuditCount = async () =>
    Number(
      (
        await fx.admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'memory.site_settings_changed'`,
        )
      ).rows[0]?.n,
    );

  it("M1: a removed Site model doesn't block other saves and is reported as removed", async () => {
    const ia = await siteAdmin();
    const w = await world();
    await catalogModel("sw-gone", w.admin.id);
    await settings(ia, "site", { settings: { learning_model_alias: "sw-gone" } });
    await fx.admin.query(`DELETE FROM model_catalog WHERE alias = 'sw-gone'`);
    expect((await settings(ia, "site")).json).toMatchObject({
      removed_models: ["learning_model_alias"],
    });
    // The console sends the whole document, stale alias included: still saves.
    const doc = ((await settings(ia, "site")).json as { settings: object }).settings;
    const saved = await settings(ia, "site", { settings: { ...doc, retention_days: 400 } });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json).toMatchObject({
      settings: { retention_days: 400, learning_model_alias: "sw-gone" },
      removed_models: ["learning_model_alias"],
    });
    // A Workspace with nothing of its own: Learn names the cause.
    expect((await settings(w.member, "effective")).json).toMatchObject({
      learn: { available: false, reason: "learning_model_removed" },
    });
  });

  it("L2/L3: no-op saves aren't audited; {} is refused; model changes audit from/to", async () => {
    const ia = await siteAdmin();
    const w = await world();
    await catalogModel("sw-a", w.admin.id);
    await catalogModel("sw-b", w.admin.id);
    expect((await settings(ia, "site", { settings: {} })).status).toBe(400);
    await settings(ia, "site", { settings: { learning_model_alias: "sw-a" } });
    expect(await lastSiteAudit()).toMatchObject({
      settings: ["learning_model_alias"],
      learningModel: { from: null, to: "sw-a" },
    });
    await settings(ia, "site", { settings: { learning_model_alias: "sw-b" } });
    expect(await lastSiteAudit()).toMatchObject({ learningModel: { from: "sw-a", to: "sw-b" } });
    const n = await siteAuditCount();
    await settings(ia, "site", { learn_enabled: true, settings: { learning_model_alias: "sw-b" } });
    expect(await siteAuditCount()).toBe(n);

    const teamAudits = async () =>
      (
        await fx.admin.query<{ target: Record<string, unknown> }>(
          `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'memory.settings_changed'
            ORDER BY seq`,
          [w.team],
        )
      ).rows.map((r) => r.target);
    await enable(w.team, "sw-a", w.admin.id);
    await settings(w.admin, "team", { learning_model_alias: "sw-a" });
    await settings(w.admin, "team", { learning_model_alias: "sw-a", learn_enabled: true });
    expect(await teamAudits()).toEqual([
      expect.objectContaining({ learningModelAlias: "sw-a", previousLearningModelAlias: null }),
    ]);
  });

  it("L5: a malformed stored Workspace model is unavailable, never the Site's model", async () => {
    const ia = await siteAdmin();
    const w = await world();
    await enable(w.team, "sw-site5", w.admin.id);
    await settings(ia, "site", { settings: { learning_model_alias: "sw-site5" } });
    expect((await settings(w.member, "effective")).json).toMatchObject({
      learn: { available: true, alias: "sw-site5", source: "site" },
    });
    await fx.admin.query(
      `UPDATE teams SET settings = jsonb_set(settings, '{memory}', '{"learning_model_alias": "Bad Alias!"}')
        WHERE id = $1`,
      [w.team],
    );
    expect((await settings(w.member, "effective")).json).toMatchObject({
      learn: { available: false, reason: "invalid_learning_model" },
    });
    // Choosing again repairs it.
    await settings(w.admin, "team", { learning_model_alias: "sw-site5" });
    expect((await settings(w.member, "effective")).json).toMatchObject({
      learn: { available: true, source: "team" },
    });
  });

  it("L1: concurrent Site settings saves of different fields both land", async () => {
    const ia = await siteAdmin();
    await Promise.all([
      settings(ia, "site", { settings: { version_cap: 30 } }),
      settings(ia, "site", { settings: { retention_days: 500 } }),
      settings(ia, "site", { settings: { stale_after_days: 60 } }),
    ]);
    expect((await settings(ia, "site")).json).toMatchObject({
      settings: { version_cap: 30, retention_days: 500, stale_after_days: 60 },
    });
  });
});

describe("turning switches off deletes nothing", () => {
  it("Notes and stored settings survive every switch off and come back on", async () => {
    const w = await world();
    expect(
      (await w.member.browser.put("/v1/memory", { scope: "user", path: "k.md", content: "keep" }))
        .status,
    ).toBe(200);
    const allOff = Object.fromEntries(
      Object.keys(WS_ON)
        .filter((k) => k !== "learning_model_alias")
        .map((k) => [k, false]),
    );
    expect((await settings(w.admin, "team", allOff)).status).toBe(200);
    const docs = await fx.admin.query(
      `SELECT 1 FROM memory_docs WHERE team_id = $1 AND deleted_at IS NULL`,
      [w.team],
    );
    expect(docs.rowCount).toBe(1);
    const on = Object.fromEntries(Object.keys(allOff).map((k) => [k, true]));
    await settings(w.admin, "team", on);
    const list = await w.member.browser.get("/v1/memory?scope=user");
    expect(list.status).toBe(200);
    expect((list.json as { docs: unknown[] }).docs).toHaveLength(1);
  });
});
