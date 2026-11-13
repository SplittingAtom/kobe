import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Person } from "./testing/event-stream-fixture.js";
import { KobeMcpHarness, type KobeWorld } from "./testing/kobe-mcp-harness.js";

/**
 * The read-only memory item tools end to end (KOBE-650, v1.3 SMA15, Chris Q4): through the real
 * MCP proxy and internal listener on a real Postgres. ac-1: Workspace items for Team admins and
 * Workspace stewards, Site items (Policy included) for Site admins and Site stewards, personal and
 * portable items never, no author ids on Site items, the Workspace switches respected. The route
 * itself refuses an agent's change and an agent's personal read (no write path to items).
 */
const h = new KobeMcpHarness();
const fx = h.fx;

beforeAll(() => h.setup());
afterAll(() => h.teardown());
beforeEach(() => h.reset());

const ITEMS = "/v1/memory/semantic/items";
const unique = (label: string) => `${label} ${randomUUID()}`;

interface MemoryWorld extends KobeWorld {
  /** A plain member with a `memory_stewards` row (Workspace steward). */
  readonly steward: Person;
  /** A plain member with the `memory_steward` site grant (Site steward). */
  readonly siteSteward: Person;
  /** Site admin, also a plain member of the team. */
  readonly siteAdmin: Person;
}

async function memoryWorld(level = "read"): Promise<MemoryWorld> {
  const w = await h.world(level);
  const steward = await fx.person(`ms${randomUUID().slice(0, 4)}`);
  const siteSteward = await fx.person(`ss${randomUUID().slice(0, 4)}`);
  const siteAdmin = await fx.person(`sa${randomUUID().slice(0, 4)}`);
  for (const p of [steward, siteSteward, siteAdmin]) {
    await fx.addMember(w.team, p);
    await fx.activate(p, w.team);
  }
  await fx.admin.query(
    `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
    [w.team, steward.id, w.admin.id],
  );
  await fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [
    siteAdmin.id,
  ]);
  await fx.admin.query(
    `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'memory_steward', $2)`,
    [siteSteward.id, siteAdmin.id],
  );
  return { ...w, steward, siteSteward, siteAdmin };
}

async function save(p: Person, scope: string, extra: Record<string, unknown> = {}) {
  const res = await p.browser.post(ITEMS, {
    scope,
    kind: scope === "portable" ? "preference" : "fact",
    statement: unique(`${scope} memory`),
    ...(scope === "portable" ? { confirm_portable: true } : {}),
    ...extra,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return (res.json as { id: string }).id;
}

const memoryNames = async (w: KobeWorld, p: Person) =>
  (await h.listNames(await h.sandboxFor(w.team, p))).filter((n) => /memory_item/.test(n));

const policies = (out: { structured?: Record<string, unknown> }) =>
  ((out.structured?.items ?? []) as { policy: boolean }[]).map((i) => i.policy);

const ids = (out: { structured?: Record<string, unknown> }) =>
  ((out.structured?.items ?? []) as { id: string }[]).map((i) => i.id);

describe("who reads memory items (ac-1)", () => {
  it("curators of each scope list their tools; members and contributors none", async () => {
    const w = await memoryWorld();
    expect(await memoryNames(w, w.member)).toEqual([]);
    expect(await memoryNames(w, w.admin)).toEqual([
      "team_memory_item_get",
      "team_memory_items_list",
    ]);
    expect(await memoryNames(w, w.steward)).toEqual([
      "team_memory_item_get",
      "team_memory_items_list",
    ]);
    expect(await memoryNames(w, w.siteSteward)).toEqual([
      "site_memory_item_get",
      "site_memory_items_list",
    ]);
    expect(await memoryNames(w, w.siteAdmin)).toEqual([
      "site_memory_item_get",
      "site_memory_items_list",
    ]);
    // A forged call by a member is refused like a 403.
    const forged = await h.call(await h.sandboxFor(w.team, w.member), "team_memory_items_list", {});
    expect(forged.isError).toBe(true);
    expect(forged.text).toContain("not available to you");
    // Revoking the steward row works at once.
    await fx.admin.query(`DELETE FROM memory_stewards WHERE team_id = $1 AND user_id = $2`, [
      w.team,
      w.steward.id,
    ]);
    expect(await memoryNames(w, w.steward)).toEqual([]);
  });
});

describe("personal and portable items are never returned (ac-1)", () => {
  it("a steward's list holds Workspace items only, and a personal id is not found", async () => {
    const w = await memoryWorld();
    const team = await save(w.admin, "team");
    const mine = await save(w.steward, "user");
    const portable = await save(w.steward, "portable");
    const s = await h.sandboxFor(w.team, w.steward);
    const listed = await h.call(s, "team_memory_items_list", {});
    expect(listed.isError, listed.text).toBeUndefined();
    expect(ids(listed)).toEqual([team]);
    for (const id of [mine, portable]) {
      const out = await h.call(s, "team_memory_item_get", { id });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("memory_item_not_found");
      expect(out.text).not.toContain(id);
    }
    const shown = await h.call(s, "team_memory_item_get", { id: team });
    expect(shown.isError, shown.text).toBeUndefined();
    expect(shown.structured).toMatchObject({
      id: team,
      updated_by: w.admin.id,
      more_versions: false,
    });
  });

  it("the route refuses an agent's personal read and every agent change", async () => {
    const w = await memoryWorld();
    const team = await save(w.admin, "team");
    const mine = await save(w.admin, "user");
    const asAdmin = await h.routesAs(w.team, w.admin);
    for (const scope of ["user", "portable"]) {
      const r = await asAdmin({ method: "GET", path: "/memory/semantic/items", query: { scope } });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: "memory_not_allowed" });
    }
    const own = await asAdmin({ method: "GET", path: `/memory/semantic/items/user/${mine}` });
    expect(own.status).toBe(403);
    const writes = [
      {
        method: "POST",
        path: "/memory/semantic/items",
        body: { scope: "team", kind: "fact", statement: "x" },
      },
      {
        method: "PATCH",
        path: `/memory/semantic/items/team/${team}`,
        body: { expected_version: 1, statement: "y" },
      },
      { method: "POST", path: `/memory/semantic/items/team/${team}/archive`, body: {} },
      { method: "POST", path: `/memory/semantic/items/team/${team}/pin`, body: { pinned: true } },
    ] as const;
    // Refused before the body is read: a malformed body is 403 too, never 400 (review I1).
    const malformed = [
      { method: "POST", path: "/memory/semantic/items", body: { nonsense: true } },
      { method: "PATCH", path: `/memory/semantic/items/team/${team}`, body: "x" },
      { method: "POST", path: `/memory/semantic/items/nowhere/not-an-id/pin` },
    ] as const;
    for (const route of [...writes, ...malformed]) {
      const r = await asAdmin(route);
      expect(r.status, route.path).toBe(403);
      expect(r.body).toMatchObject({ code: "memory_not_allowed" });
    }
    // Nothing changed: still version 1, active, unpinned.
    const read = await w.admin.browser.get(`${ITEMS}/team/${team}`);
    expect(read.json).toMatchObject({ version: 1, status: "active", pinned: false });
    // A member's delegated read of Workspace items is refused too (curators only).
    const asMember = await h.routesAs(w.team, w.member);
    const m = await asMember({
      method: "GET",
      path: "/memory/semantic/items",
      query: { scope: "team" },
    });
    expect(m.status).toBe(403);
  });
});

describe("source conversations (review L2)", () => {
  it("shown only to a curator who can open that conversation", async () => {
    const w = await memoryWorld();
    // The steward saves from their own private conversation.
    const own = await h.sandboxFor(w.team, w.steward);
    const id = await save(w.steward, "team", { source_thread_id: own.threadId });
    const versions = (out: { structured?: Record<string, unknown> }) =>
      (out.structured?.versions ?? []) as Record<string, unknown>[];
    const mine = await h.call(own, "team_memory_item_get", { id });
    expect(mine.isError, mine.text).toBeUndefined();
    expect(versions(mine)[0]).toMatchObject({ source_thread_id: own.threadId });
    // The Team admin curates but cannot open the steward's private conversation: no id.
    const admin = await h.call(await h.sandboxFor(w.team, w.admin), "team_memory_item_get", { id });
    expect(admin.isError, admin.text).toBeUndefined();
    expect(versions(admin)[0]).not.toHaveProperty("source_thread_id");
    expect(admin.text).not.toContain(own.threadId);
    // The console still shows curators the link (unchanged for people in the browser).
    const consoleRead = await w.admin.browser.get(`${ITEMS}/team/${id}`);
    expect(JSON.stringify(consoleRead.json)).toContain(own.threadId);
  });
});

describe("Site items (ac-1)", () => {
  it("Policy is readable, and no author id reaches the Workspace", async () => {
    const w = await memoryWorld();
    const fact = await save(w.siteAdmin, "site");
    const policy = await save(w.siteAdmin, "site", { policy: true, kind: "convention" });
    const s = await h.sandboxFor(w.team, w.siteSteward);
    const all = await h.call(s, "site_memory_items_list", {});
    expect(all.isError, all.text).toBeUndefined();
    // Site items are site-wide: other tests' items may be listed too.
    expect(ids(all)).toEqual(expect.arrayContaining([fact, policy]));
    const only = await h.call(s, "site_memory_items_list", { policy: true });
    expect(ids(only)).toContain(policy);
    expect(ids(only)).not.toContain(fact);
    expect(policies(only).every(Boolean)).toBe(true);
    // Even the Site admin who wrote them gets no author ids through the tool.
    const admin = await h.sandboxFor(w.team, w.siteAdmin);
    const shown = await h.call(admin, "site_memory_item_get", { id: policy });
    expect(shown.isError, shown.text).toBeUndefined();
    expect(shown.structured).toMatchObject({ id: policy, policy: true, more_versions: false });
    expect(shown.text).not.toContain(w.siteAdmin.id);
    expect(all.text).not.toContain(w.siteAdmin.id);
    // A Workspace curator without a Site right reads no Site item, even through the route.
    const asAdmin = await h.routesAs(w.team, w.admin);
    const r = await asAdmin({ method: "GET", path: `/memory/semantic/items/site/${fact}` });
    expect(r.status).toBe(403);
  });
});

describe("the Workspace switches apply (ac-1)", () => {
  it("memories off refuses with memory_disabled; Site memories off leaves Policy", async () => {
    const w = await memoryWorld();
    await save(w.admin, "team");
    const fact = await save(w.siteAdmin, "site");
    const policy = await save(w.siteAdmin, "site", { policy: true, kind: "convention" });
    const off = await w.admin.browser.put("/v1/memory/settings?level=team", {
      memories_enabled: false,
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const out = await h.call(await h.sandboxFor(w.team, w.steward), "team_memory_items_list", {});
    expect(out.isError).toBe(true);
    expect(out.text).toContain("memory_disabled");

    const back = await w.admin.browser.put("/v1/memory/settings?level=team", {
      memories_enabled: true,
      site_memories_enabled: false,
    });
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    const site = await h.call(
      await h.sandboxFor(w.team, w.siteSteward),
      "site_memory_items_list",
      {},
    );
    expect(site.isError, site.text).toBeUndefined();
    expect(ids(site)).toContain(policy);
    expect(ids(site)).not.toContain(fact);
    expect(policies(site).every(Boolean)).toBe(true);
  });
});

describe("pages are bounded", () => {
  it("at most 20 a page, with a cursor to the rest", async () => {
    const w = await memoryWorld();
    for (let i = 0; i < 23; i++) await save(w.admin, "team");
    const s = await h.sandboxFor(w.team, w.admin);
    const first = await h.call(s, "team_memory_items_list", {});
    expect(ids(first)).toHaveLength(20);
    const cursor = first.structured?.next_cursor as string;
    expect(typeof cursor).toBe("string");
    const second = await h.call(s, "team_memory_items_list", { cursor });
    expect(ids(second)).toHaveLength(3);
    expect(second.structured?.next_cursor).toBeNull();
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(23);
  });
});
