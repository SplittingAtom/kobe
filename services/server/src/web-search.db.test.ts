import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvelope } from "@kobe/db";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/** KOBE-113: install web-search provider and key, team opt-in. The key is never returned. */
const KEY = "BSA-live-AbCdEf0123456789XyZ";
const KEY2 = "BSA-live-SecondKey0123456789";
const INSTALL = "/v1/install/web-search";
const TEAM = "/v1/team/web-search";
const team = randomUUID();
let h: Harness;
let owner: TestBrowser;
let member: TestBrowser;
let teamAdmin: TestBrowser;

beforeAll(async () => {
  const envelope = loadEnvelope({ KOBE_ENVELOPE_KEY: "e".repeat(48) });
  h = await openHarness({ ...(envelope ? { envelope } : {}) });
  await h.createUser("owner@ws.test", "owner");
  const memberId = await h.createUser("member@ws.test");
  const adminId = await h.createUser("tadmin@ws.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'ws', 'ws')`, [team]);
  for (const [id, role] of [
    [memberId, "member"],
    [adminId, "team_admin"],
  ] as const) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      id,
      role,
    ]);
  }
  owner = await h.signIn("owner@ws.test");
  member = await h.signIn("member@ws.test");
  teamAdmin = await h.signIn("tadmin@ws.test");
  for (const who of [member, teamAdmin]) {
    expect((await who.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    who.team = team;
  }
});
afterAll(async () => {
  await h?.close();
});

describe("install setting", () => {
  it("starts unconfigured and lists providers", async () => {
    const res = await owner.get(INSTALL);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ configured: false });
    expect(res.json.providers.map((p: { id: string }) => p.id)).toEqual(["brave", "tavily", "exa"]);
  });

  it("needs install admin rights", async () => {
    expect((await member.get(INSTALL)).status).toBe(403);
    expect((await member.put(INSTALL, { provider: "brave", api_key: KEY })).status).toBe(403);
    expect((await h.browser().get(INSTALL)).status).toBe(401);
  });

  it("validates the body", async () => {
    for (const body of [
      {},
      { provider: "bing", api_key: KEY },
      { provider: "brave" },
      { provider: "brave", api_key: "short" },
      { provider: "brave", api_key: "has a space in it" },
      { provider: "brave", api_key: KEY, extra: 1 },
    ]) {
      expect((await owner.put(INSTALL, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("stores the key sealed and returns only a masked hint", async () => {
    const res = await owner.put(INSTALL, { provider: "brave", api_key: KEY });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({
      configured: true,
      provider: "brave",
      enabled: true,
      hint: `••••${KEY.slice(-4)}`,
    });
    expect(res.text).not.toContain(KEY);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await owner.get(INSTALL)).text).not.toContain(KEY);
    const { rows } = await h.admin.query(`SELECT * FROM web_search_settings`);
    expect(rows).toHaveLength(1);
    expect(rows[0].sealed).toMatch(/^e1\./);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it("adds the provider domain to the egress ceiling", async () => {
    const { rows } = await h.admin.query(
      `SELECT in_ceiling FROM egress_domains WHERE domain = 'api.search.brave.com'`,
    );
    expect(rows[0]?.in_ceiling).toBe(true);
  });

  it("keeps the key when only enabled changes, and needs a new key for a new provider", async () => {
    const before = (await h.admin.query(`SELECT sealed FROM web_search_settings`)).rows[0].sealed;
    const off = await owner.put(INSTALL, { provider: "brave", enabled: false });
    expect(off.status).toBe(200);
    expect(off.json.enabled).toBe(false);
    expect((await h.admin.query(`SELECT sealed FROM web_search_settings`)).rows[0].sealed).toBe(
      before,
    );
    expect((await owner.put(INSTALL, { provider: "tavily", enabled: true })).status).toBe(400);
    expect((await owner.put(INSTALL, { provider: "brave", api_key: KEY2 })).status).toBe(200);
  });

  it("audits changes without the key or hint", async () => {
    const { rows } = await h.admin.query(
      `SELECT action, target FROM audit_log WHERE action LIKE 'mcp.web_search.%' ORDER BY seq`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const dump = JSON.stringify(rows);
    for (const secret of [KEY, KEY2, KEY.slice(-4), "••••"]) expect(dump).not.toContain(secret);
  });
});

describe("team opt-in", () => {
  it("is available only while the install enables a provider", async () => {
    await owner.put(INSTALL, { provider: "brave", enabled: true });
    const res = await teamAdmin.get(TEAM);
    expect(res.json).toEqual({ available: true, enabled: false, provider: "brave" });
    await owner.put(INSTALL, { provider: "brave", enabled: false });
    expect((await teamAdmin.get(TEAM)).json).toMatchObject({ available: false });
    expect((await teamAdmin.put(TEAM, { enabled: true })).status).toBe(409);
    await owner.put(INSTALL, { provider: "brave", enabled: true });
  });

  it("lets only team admins change it, and members read it", async () => {
    expect((await member.put(TEAM, { enabled: true })).status).toBe(403);
    expect((await member.get(TEAM)).status).toBe(200);
    expect((await teamAdmin.put(TEAM, { enabled: "yes" })).status).toBe(400);
    expect((await teamAdmin.put(TEAM, { enabled: true })).json).toMatchObject({ enabled: true });
    expect((await member.get(TEAM)).json).toMatchObject({ enabled: true });
    expect((await teamAdmin.put(TEAM, { enabled: false })).json).toMatchObject({ enabled: false });
  });
});

describe("removing the provider", () => {
  it("deletes the key; team opt-ins go dormant", async () => {
    await teamAdmin.put(TEAM, { enabled: true });
    expect((await member.delete(INSTALL)).status).toBe(403);
    expect((await owner.delete(INSTALL)).status).toBe(204);
    expect((await owner.delete(INSTALL)).status).toBe(404);
    expect((await owner.get(INSTALL)).json).toMatchObject({ configured: false });
    expect((await h.admin.query(`SELECT 1 FROM web_search_settings`)).rows).toHaveLength(0);
    expect((await teamAdmin.get(TEAM)).json).toMatchObject({ available: false, enabled: false });
  });
});
