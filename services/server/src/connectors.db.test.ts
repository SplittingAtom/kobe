import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolHash } from "./connectors/pin.js";
import type { ProbeResult } from "./connectors/probe.js";
import { openHarness, type Harness } from "./testing/harness.js";
import type { TestBrowser } from "./testing/browser.js";

/**
 * Connector registry (KOBE-100, D6, D27): install admins register, edit and remove MCP servers;
 * team admins and members can't; URLs must pass the address policy; audit never holds a URL.
 */
const BASE = "/v1/install/connectors";
const teamId = randomUUID();
const PUBLIC = "93.184.216.34";
let h: Harness;
let root: TestBrowser;
let alice: TestBrowser;
let bob: TestBrowser;
let aliceId = "";
let resolved: string[] = [PUBLIC];
let probeAnswer: (url: string) => ProbeResult = () => ({ ok: false, failure: "proxy_unavailable" });
const probedUrls: string[] = [];

const body = (over: Record<string, unknown> = {}) => ({
  name: "github",
  url: "https://mcp.github.example/mcp",
  authKind: "oauth",
  ...over,
});
const create = (over: Record<string, unknown> = {}) => root.post(BASE, body(over));

beforeAll(async () => {
  h = await openHarness({
    connectors: { resolve: async () => resolved },
    connectorProbe: {
      probe: async (url) => {
        probedUrls.push(url);
        return probeAnswer(url);
      },
    },
  });
  await h.createUser("root@conn.test", "admin");
  aliceId = await h.createUser("alice@conn.test");
  await h.createUser("bob@conn.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance')`, [
    teamId,
  ]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
    [teamId, aliceId],
  );
  root = await h.signIn("root@conn.test");
  alice = await h.signIn("alice@conn.test");
  bob = await h.signIn("bob@conn.test");
  alice.team = teamId;
});
afterAll(async () => {
  await h?.close();
});

describe("access", () => {
  it("is for install admins only", async () => {
    for (const who of [alice, bob]) {
      expect((await who.get(BASE)).status).toBe(403);
      expect((await who.post(BASE, body())).status).toBe(403);
      expect((await who.patch(`${BASE}/${randomUUID()}`, { name: "x" })).status).toBe(403);
      expect((await who.delete(`${BASE}/${randomUUID()}`)).status).toBe(403);
    }
    expect((await h.browser().get(BASE)).status).toBe(401);
  });
});

describe("create and read", () => {
  it("registers a connector and lists it", async () => {
    const res = await create({ iconUrl: "https://cdn.example/icon.png" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.connector).toMatchObject({
      name: "github",
      url: "https://mcp.github.example/mcp",
      iconUrl: "https://cdn.example/icon.png",
      authKind: "oauth",
      status: "active",
      toolCount: 0,
    });
    const list = await root.get(BASE);
    expect(list.json.connectors.map((c: { name: string }) => c.name)).toEqual(["github"]);
    const one = await root.get(`${BASE}/${res.json.connector.id}`);
    expect(one.json.connector.id).toBe(res.json.connector.id);
  });

  it("defaults auth to none and refuses duplicates, also across - and _", async () => {
    const ok = await create({
      name: "jira-cloud",
      authKind: undefined,
      url: "https://j.example/mcp",
    });
    expect(ok.status).toBe(201);
    expect(ok.json.connector.authKind).toBe("none");
    for (const name of ["github", "jira_cloud"]) {
      const dup = await create({ name, url: "https://x.example/mcp" });
      expect(dup.status).toBe(409);
      expect(dup.json.code).toBe("name_taken");
    }
  });

  it("validates fields", async () => {
    for (const bad of [
      { name: "Bad Name" },
      { name: "" },
      { authKind: "basic" },
      { iconUrl: "http://cdn.example/i.png" },
      { iconUrl: "javascript:alert(1)" },
      { iconUrl: "data:image/png;base64,AAAA" },
      { url: 5 },
    ]) {
      const res = await create({ name: "valid-one", ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await root.post(BASE, { ...body({ name: "extra" }), toolsSnapshot: [] })).status).toBe(
      400,
    );
  });
});

describe("URL policy", () => {
  it.each([
    ["http://mcp.example/mcp", "https_required"],
    ["https://127.0.0.1/mcp", "address_not_allowed"],
    ["https://169.254.169.254/latest", "address_not_allowed"],
    ["https://10.0.0.8/mcp", "address_not_allowed"],
    ["https://u:p@mcp.example/mcp", "credentials_in_url"],
    ["https://mcp.example/mcp?key=sekret", "query_in_url"],
  ])("refuses %s", async (url, code) => {
    const res = await create({ name: `p-${randomUUID().slice(0, 6)}`, url });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe(code);
    expect(JSON.stringify(res.json)).not.toContain("u:p");
    expect(JSON.stringify(res.json)).not.toContain("sekret");
  });

  it("refuses a name that resolves to a private address, on create and on edit", async () => {
    resolved = ["10.1.1.1"];
    try {
      const res = await create({ name: "rebind", url: "https://rebind.example/mcp" });
      expect(res.status).toBe(422);
      const list = await root.get(BASE);
      const id = list.json.connectors.find((c: { name: string }) => c.name === "github").id;
      const edit = await root.patch(`${BASE}/${id}`, { url: "https://rebind.example/mcp" });
      expect(edit.status).toBe(422);
      expect(edit.json.code).toBe("address_not_allowed");
    } finally {
      resolved = [PUBLIC];
    }
  });
});

describe("edit", () => {
  it("updates fields, clears the icon and resets the pinned tools when the URL changes", async () => {
    const created = await create({
      name: "edit-me",
      url: "https://a.example/mcp",
      iconUrl: "https://cdn.example/e.png",
    });
    const id = created.json.connector.id as string;
    await h.admin.query(
      `UPDATE connectors SET tools_snapshot = '[{"name":"t"}]'::jsonb, tools_hash = $2 WHERE id = $1`,
      [id, "a".repeat(64)],
    );
    const same = await root.patch(`${BASE}/${id}`, { name: "edit-me-2", authKind: "api_key" });
    expect(same.status).toBe(200);
    expect(same.json.connector).toMatchObject({
      name: "edit-me-2",
      authKind: "api_key",
      toolCount: 1,
    });
    const moved = await root.patch(`${BASE}/${id}`, {
      url: "https://b.example/mcp",
      iconUrl: null,
    });
    expect(moved.json.connector).toMatchObject({
      url: "https://b.example/mcp",
      iconUrl: null,
      toolCount: 0,
    });
    const { rows } = await h.admin.query(`SELECT tools_hash FROM connectors WHERE id = $1`, [id]);
    expect(rows[0].tools_hash).toBeNull();
  });

  it("disables and re-enables, 404s unknown ids, 400s an empty patch, 409s a taken name", async () => {
    const id = (await create({ name: "toggle", url: "https://t.example/mcp" })).json.connector.id;
    expect((await root.patch(`${BASE}/${id}`, { status: "disabled" })).json.connector.status).toBe(
      "disabled",
    );
    expect((await root.patch(`${BASE}/${id}`, { status: "active" })).json.connector.status).toBe(
      "active",
    );
    expect((await root.patch(`${BASE}/${randomUUID()}`, { name: "zzz" })).status).toBe(404);
    expect((await root.patch(`${BASE}/not-a-uuid`, { name: "zzz" })).status).toBe(404);
    expect((await root.patch(`${BASE}/${id}`, {})).status).toBe(400);
    const taken = await root.patch(`${BASE}/${id}`, { name: "github" });
    expect(taken.status).toBe(409);
  });
});

describe("delete", () => {
  it("soft-deletes an unused connector too: never a hard delete", async () => {
    const id = (await create({ name: "unused", url: "https://u.example/mcp" })).json.connector.id;
    const res = await root.delete(`${BASE}/${id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ removed: true, soft: true, teams: 0 });
    const { rows } = await h.admin.query(`SELECT deleted_at FROM connectors WHERE id = $1`, [id]);
    expect(rows[0].deleted_at).not.toBeNull();
    expect((await root.delete(`${BASE}/${id}`)).status).toBe(404);
  });

  it("never loses a team's enablement made while the connector is being removed", async () => {
    const id = (await create({ name: "racy", url: "https://r.example/mcp" })).json.connector.id;
    const enable = h.admin.query(
      `INSERT INTO team_connectors (team_id, connector_id, enabled_by) VALUES ($1, $2, $3)`,
      [teamId, id, aliceId],
    );
    const [removal] = await Promise.all([root.delete(`${BASE}/${id}`), enable]);
    expect(removal.status).toBe(200);
    const kept = await h.admin.query(`SELECT 1 FROM team_connectors WHERE connector_id = $1`, [id]);
    expect(kept.rows).toHaveLength(1);
  });

  it("keeps a connector teams use as a disabled, hidden row with a clear message", async () => {
    const id = (await create({ name: "in-use", url: "https://i.example/mcp" })).json.connector.id;
    await h.admin.query(
      `INSERT INTO team_connectors (team_id, connector_id, enabled_by) VALUES ($1, $2, $3)`,
      [teamId, id, aliceId],
    );
    const res = await root.delete(`${BASE}/${id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ removed: true, soft: true, teams: 1 });
    expect(res.json.message).toMatch(/1 team/);
    const { rows } = await h.admin.query(
      `SELECT status, deleted_at FROM connectors WHERE id = $1`,
      [id],
    );
    expect(rows[0].status).toBe("disabled");
    expect(rows[0].deleted_at).not.toBeNull();
    const list = await root.get(BASE);
    expect(list.json.connectors.map((c: { id: string }) => c.id)).not.toContain(id);
    expect((await root.get(`${BASE}/${id}`)).status).toBe(404);
    expect((await root.patch(`${BASE}/${id}`, { status: "active" })).status).toBe(404);
    const again = await create({ name: "in-use", url: "https://i.example/mcp" });
    expect(again.status).toBe(409);
    expect(again.json.message).toMatch(/removed/i);
    // The team's enablement row is kept (a later ticket decides what it means).
    const kept = await h.admin.query(`SELECT 1 FROM team_connectors WHERE connector_id = $1`, [id]);
    expect(kept.rows).toHaveLength(1);
  });
});

describe("audit", () => {
  it("records ids, names and field names, never URLs or icons", async () => {
    const { rows } = await h.admin.query(
      `SELECT action, team_id, target FROM audit_log WHERE action LIKE 'mcp.connector.%' ORDER BY seq`,
    );
    const actions = new Set(rows.map((r) => r.action));
    expect(actions).toEqual(
      new Set(["mcp.connector.registered", "mcp.connector.updated", "mcp.connector.removed"]),
    );
    for (const r of rows) {
      expect(r.team_id).toBeNull();
      expect(JSON.stringify(r.target)).not.toMatch(/https?:|example/);
    }
    const updated = rows.find(
      (r) => r.action === "mcp.connector.updated" && r.target.changed.includes("url"),
    );
    expect(updated?.target.changed).toEqual(["url", "iconUrl"]);
  });

  it("writes nothing for a refused request", async () => {
    const before = await h.admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'mcp.connector.%'`,
    );
    await create({ name: "refused", url: "http://insecure.example/mcp" });
    const after = await h.admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'mcp.connector.%'`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("probe and pin (KOBE-101)", () => {
  const issueTool = {
    name: "create_issue",
    description: "Create an issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  };
  const readTool = { name: "get.issue", inputSchema: { type: "object" } };
  const pinRows = async (id: string) =>
    (await h.admin.query(`SELECT tools_snapshot, tools_hash FROM connectors WHERE id = $1`, [id]))
      .rows[0];

  it("snapshots and pins every tool when a connector is registered (ac-1)", async () => {
    probeAnswer = () => ({ ok: true, tools: [issueTool, readTool] });
    const res = await create({ name: "pinned-one", url: "https://p1.example/mcp" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.pin).toEqual({ ok: true, tools: 2 });
    expect(res.json.connector.toolCount).toBe(2);
    expect(probedUrls.at(-1)).toBe("https://p1.example/mcp");
    const row = await pinRows(res.json.connector.id);
    expect(row.tools_hash).toMatch(/^[0-9a-f]{64}$/);
    const pinned = row.tools_snapshot as {
      name: string;
      pi_name: string;
      sha256: string;
      status: string;
    }[];
    expect(pinned.map((t) => [t.name, t.pi_name, t.status])).toEqual([
      ["create_issue", "mcp__pinned_one__create_issue", "pinned"],
      ["get.issue", "mcp__pinned_one__get_issue", "pinned"],
    ]);
    expect(pinned[0]?.sha256).toBe(toolHash(issueTool));
    const { rows } = await h.admin.query(
      `SELECT target FROM audit_log WHERE action = 'mcp.connector.pinned'`,
    );
    expect(rows[0].target).toMatchObject({ name: "pinned-one", tools: 2 });
    expect(JSON.stringify(rows[0].target)).not.toMatch(/https?:|example/);
  });

  it("registers an unreachable connector unpinned, and pins on a later probe", async () => {
    probeAnswer = () => ({ ok: false, failure: "unreachable" });
    const res = await create({ name: "late-pin", url: "https://p2.example/mcp" });
    expect(res.status).toBe(201);
    expect(res.json.pin).toMatchObject({ ok: false, failure: "unreachable" });
    expect(res.json.connector.toolCount).toBe(0);
    const id = res.json.connector.id as string;

    probeAnswer = () => ({ ok: true, tools: [issueTool] });
    const again = await root.post(`${BASE}/${id}/pin`, {});
    expect(again.status).toBe(200);
    expect(again.json.pin).toEqual({ ok: true, tools: 1 });
    expect((await pinRows(id)).tools_snapshot).toHaveLength(1);

    // Pins that exist are never replaced by a probe (drift needs re-approval).
    probeAnswer = () => ({ ok: true, tools: [readTool] });
    const third = await root.post(`${BASE}/${id}/pin`, {});
    expect(third.json.pin).toMatchObject({ ok: false, failure: "already_pinned" });
    expect((await pinRows(id)).tools_snapshot[0].name).toBe("create_issue");
  });

  it("pins nothing for a tool list Kobe cannot pin unambiguously", async () => {
    probeAnswer = () => ({
      ok: true,
      tools: [
        { name: "get-x", inputSchema: {} },
        { name: "get_x", inputSchema: {} },
      ],
    });
    const res = await create({ name: "collide", url: "https://p3.example/mcp" });
    expect(res.json.pin).toMatchObject({ ok: false, failure: "ambiguous_tool_names" });
    expect(res.json.connector.toolCount).toBe(0);
  });

  it("re-pins the new server's tools when the URL changes", async () => {
    probeAnswer = () => ({ ok: true, tools: [issueTool] });
    const created = await create({ name: "moves", url: "https://p4.example/mcp" });
    const id = created.json.connector.id as string;
    const old = await pinRows(id);
    probeAnswer = () => ({ ok: true, tools: [readTool, issueTool] });
    const moved = await root.patch(`${BASE}/${id}`, { url: "https://p5.example/mcp" });
    expect(moved.json.pin).toEqual({ ok: true, tools: 2 });
    expect(moved.json.connector.toolCount).toBe(2);
    expect((await pinRows(id)).tools_hash).not.toBe(old.tools_hash);
    // An edit that keeps the URL does not probe or report a pin.
    const before = probedUrls.length;
    const renamed = await root.patch(`${BASE}/${id}`, { authKind: "none" });
    expect(renamed.json.pin).toBeUndefined();
    expect(probedUrls.length).toBe(before);
  });

  it("is for install admins only and 404s unknown connectors", async () => {
    expect((await alice.post(`${BASE}/${randomUUID()}/pin`, {})).status).toBe(403);
    expect((await root.post(`${BASE}/${randomUUID()}/pin`, {})).status).toBe(404);
  });
});
