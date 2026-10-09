import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvelope } from "@kobe/db";
import type { ProbeResult } from "./connectors/probe.js";
import { createMcpService } from "./mcp/service.js";
import { createInternalApp } from "./routes/internal.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { INTERNAL_KEY, MCP_SESSION_KEY, mcpToken } from "./testing/mcp-fixtures.js";

/**
 * Per-user API-key grants (KOBE-108): the key is sealed at rest, no API returns it, only the run's
 * own user's key is ever served to the proxy, and nothing about it is audited.
 */
const KEY = "sk-live-AbCdEf0123456789XyZ";
const KEY2 = "sk-live-SecondKey0123456789";
const BASE = "/v1/connector-grants";
const teamT = randomUUID();
const teamU = randomUUID();
let h: Harness;
let alice: TestBrowser;
let bob: TestBrowser;
let carol: TestBrowser;
let aliceId = "";
let bobId = "";
let carolId = "";
let apiKeyConnector = "";
let otherApiKeyConnector = "";
let noneConnector = "";
let notEnabledConnector = "";
let internal: ReturnType<typeof createInternalApp>;
const probes: { url: string; apiKey: string | undefined }[] = [];
let probeAnswer: ProbeResult = { ok: false, failure: "auth_required" };

function envelope() {
  const loaded = loadEnvelope({ KOBE_ENVELOPE_KEY: "e".repeat(48) });
  if (!loaded) throw new Error("envelope not loaded");
  return loaded;
}

async function connector(name: string, authKind: string, enableFor: string[]): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO connectors (name, url, auth_kind) VALUES ($1, 'https://mcp.example.com/mcp', $2) RETURNING id`,
    [`${name}-${randomUUID().slice(0, 6)}`, authKind],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("connector insert returned nothing");
  for (const team of enableFor) {
    await h.admin.query(
      `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
      [team, id, aliceId],
    );
  }
  return id;
}

beforeAll(async () => {
  h = await openHarness({
    envelope: envelope(),
    connectorProbe: {
      probe: (url, apiKey) => {
        probes.push({ url, apiKey });
        return Promise.resolve(probeAnswer);
      },
    },
  });
  aliceId = await h.createUser("alice@grants.test");
  bobId = await h.createUser("bob@grants.test");
  carolId = await h.createUser("carol@grants.test");
  for (const [id, slug] of [
    [teamT, "t"],
    [teamU, "u"],
  ] as const) {
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  }
  for (const [team, user] of [
    [teamT, aliceId],
    [teamT, bobId],
    [teamU, aliceId],
    [teamU, carolId],
  ] as const) {
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [team, user],
    );
  }
  apiKeyConnector = await connector("keyed", "api_key", [teamT, teamU]);
  otherApiKeyConnector = await connector("keyed2", "api_key", [teamT]);
  noneConnector = await connector("open", "none", [teamT]);
  notEnabledConnector = await connector("off", "api_key", [teamU]);
  alice = await h.signIn("alice@grants.test");
  bob = await h.signIn("bob@grants.test");
  carol = await h.signIn("carol@grants.test");
  for (const [who, team] of [
    [alice, teamT],
    [bob, teamT],
    [carol, teamU],
  ] as const) {
    expect((await who.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    who.team = team;
  }
  internal = createInternalApp({
    internalKey: INTERNAL_KEY,
    mcp: h.deps.mcp,
    auth: {
      db: h.deps.database.db,
      sessionKey: MCP_SESSION_KEY,
      liveness: { isLive: () => Promise.resolve(true) },
    },
  });
});
afterAll(async () => {
  await h?.close();
});

const grantFor = async (team: string, user: string, connectorId: string, withKey = true) => {
  const token = mcpToken({ sandboxId: randomUUID(), teamId: team, userId: user });
  const res = await internal.request(`/internal/v1/mcp/connectors/${connectorId}/grant`, {
    method: "POST",
    headers: {
      ...(withKey ? { authorization: `Bearer ${INTERNAL_KEY}` } : {}),
      "kobe-sandbox-token": token,
    },
  });
  return { status: res.status, text: await res.text() };
};
const keyOf = (text: string) => (JSON.parse(text) as { api_key: string }).api_key;

describe("adding, replacing and removing a key", () => {
  it("stores the key and returns only a masked hint", async () => {
    const res = await alice.put(`${BASE}/${apiKeyConnector}`, { api_key: KEY });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({
      grant: { connector_id: apiKeyConnector, hint: `••••${KEY.slice(-4)}` },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.text).not.toContain(KEY);
    const list = await alice.get(BASE);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(KEY);
    const grants = (list.json as { grants: Record<string, unknown>[] }).grants;
    expect(Object.keys(grants[0] ?? {}).sort()).toEqual([
      "connector_id",
      "created_at",
      "hint",
      "updated_at",
    ]);
  });

  it("keeps only the envelope in Postgres, never the key", async () => {
    const { rows } = await h.admin.query(`SELECT * FROM connector_grants`);
    expect(rows).toHaveLength(1);
    expect(rows[0].sealed).toMatch(/^e1\./);
    expect(JSON.stringify(rows)).not.toContain(KEY);
    expect(rows[0].key_id).toBe(h.deps.envelope?.currentKeyId);
  });

  it("replaces the key (200) and serves the new one", async () => {
    const res = await alice.put(`${BASE}/${apiKeyConnector}`, { api_key: KEY2 });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(KEY2);
    expect(keyOf((await grantFor(teamT, aliceId, apiKeyConnector)).text)).toBe(KEY2);
  });

  it("validates the key and the connector", async () => {
    const put = (id: string, body: unknown) => alice.put(`${BASE}/${id}`, body);
    for (const body of [
      {},
      { api_key: "short" },
      { api_key: "has a space in it" },
      { api_key: "x".repeat(2049) },
      { api_key: KEY, extra: 1 },
      { api_key: 12345678 },
    ]) {
      expect((await put(otherApiKeyConnector, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await put(noneConnector, { api_key: KEY })).status).toBe(422);
    expect((await put(notEnabledConnector, { api_key: KEY })).status).toBe(404);
    expect((await put(randomUUID(), { api_key: KEY })).status).toBe(404);
    expect((await put("not-a-uuid", { api_key: KEY })).status).toBe(404);
    const anon = await h.browser().put(`${BASE}/${otherApiKeyConnector}`, { api_key: KEY });
    expect(anon.status).toBe(401);
  });

  it("removes the key; then nothing is served", async () => {
    expect((await bob.delete(`${BASE}/${apiKeyConnector}`)).status).toBe(404);
    expect((await alice.delete(`${BASE}/${apiKeyConnector}`)).status).toBe(204);
    expect((await alice.delete(`${BASE}/${apiKeyConnector}`)).status).toBe(404);
    expect((await grantFor(teamT, aliceId, apiKeyConnector)).status).toBe(404);
    expect((await alice.get(BASE)).json).toEqual({ grants: [] });
  });

  it("audits add, replace and remove without the key or its hint", async () => {
    const { rows } = await h.admin.query(
      `SELECT action, team_id, target FROM audit_log WHERE action LIKE 'mcp.grant.%' ORDER BY seq`,
    );
    expect(rows.map((r) => r.action)).toEqual([
      "mcp.grant.added",
      "mcp.grant.replaced",
      "mcp.grant.removed",
    ]);
    expect(rows.every((r) => r.team_id === teamT)).toBe(true);
    expect(rows[0].target).toMatchObject({ connectorId: apiKeyConnector });
    const all = JSON.stringify((await h.admin.query(`SELECT * FROM audit_log`)).rows);
    for (const secret of [KEY, KEY2, KEY.slice(-4), KEY2.slice(-4)]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("whose key is used", () => {
  it("serves a user's key only to that user's sandbox, in that team", async () => {
    await alice.put(`${BASE}/${apiKeyConnector}`, { api_key: KEY });
    expect(keyOf((await grantFor(teamT, aliceId, apiKeyConnector)).text)).toBe(KEY);
    // Same team, other user: no key (never alice's).
    const bobs = await grantFor(teamT, bobId, apiKeyConnector);
    expect(bobs.status).toBe(404);
    expect(bobs.text).not.toContain(KEY);
    // Same user in another team that also enabled the connector: the grant belongs to team T.
    const inU = await grantFor(teamU, aliceId, apiKeyConnector);
    expect(inU.status).toBe(404);
    expect(inU.text).not.toContain(KEY);
    // Another team's user, and a user who is not in the token's team at all.
    expect((await grantFor(teamU, carolId, apiKeyConnector)).status).toBe(404);
    const stranger = await grantFor(teamT, carolId, apiKeyConnector);
    expect(stranger.status).toBe(401);
    expect(stranger.text).not.toContain(KEY);
  });

  it("each user's key is their own", async () => {
    await bob.put(`${BASE}/${apiKeyConnector}`, { api_key: KEY2 });
    expect(keyOf((await grantFor(teamT, aliceId, apiKeyConnector)).text)).toBe(KEY);
    expect(keyOf((await grantFor(teamT, bobId, apiKeyConnector)).text)).toBe(KEY2);
    expect((await bob.get(BASE)).text).not.toContain(KEY);
    expect((await carol.get(BASE)).json).toEqual({ grants: [] });
    // Carol cannot touch Alice's or Bob's key through her own team.
    expect((await carol.delete(`${BASE}/${apiKeyConnector}`)).status).toBe(404);
    expect((await grantFor(teamT, aliceId, apiKeyConnector)).status).toBe(200);
  });

  it("requires the internal key; the sandbox token alone gets nothing", async () => {
    const res = await grantFor(teamT, aliceId, apiKeyConnector, false);
    expect(res.status).toBe(401);
    expect(res.text).not.toContain(KEY);
  });

  it("does not serve a key for a disabled connector or one the team no longer enables", async () => {
    await carol.put(`${BASE}/${apiKeyConnector}`, { api_key: KEY });
    expect((await grantFor(teamU, carolId, apiKeyConnector)).status).toBe(200);
    await h.admin.query(`UPDATE connectors SET status = 'disabled' WHERE id = $1`, [
      apiKeyConnector,
    ]);
    expect((await grantFor(teamU, carolId, apiKeyConnector)).status).toBe(404);
    await h.admin.query(`UPDATE connectors SET status = 'active' WHERE id = $1`, [apiKeyConnector]);
    await h.admin.query(`DELETE FROM team_connectors WHERE team_id = $1 AND connector_id = $2`, [
      teamU,
      apiKeyConnector,
    ]);
    expect((await grantFor(teamU, carolId, apiKeyConnector)).status).toBe(404);
  });

  it("refuses a ciphertext moved to another user's row (bound to team, user and connector)", async () => {
    await h.admin.query(
      `UPDATE connector_grants SET sealed = (SELECT sealed FROM connector_grants WHERE user_id = $1 AND team_id = $3 AND connector_id = $4)
       WHERE user_id = $2 AND team_id = $3 AND connector_id = $4`,
      [aliceId, bobId, teamT, apiKeyConnector],
    );
    const moved = await grantFor(teamT, bobId, apiKeyConnector);
    expect(moved.status).toBe(503);
    expect(moved.text).not.toContain(KEY);
  });

  it("serves nothing without an envelope key", async () => {
    const bare = createMcpService({
      db: h.deps.database.db,
      policy: undefined as never,
      runContext: undefined as never,
    });
    const principal = { sandboxId: randomUUID(), teamId: teamT, userId: aliceId };
    expect(await bare.revealCredential(principal, apiKeyConnector)).toEqual({
      ok: false,
      failure: "unavailable",
    });
  });
});

describe("nothing else carries the key", () => {
  it("is not in the tools listing the proxy receives", async () => {
    const token = mcpToken({ sandboxId: randomUUID(), teamId: teamT, userId: aliceId });
    const res = await internal.request(`/internal/v1/mcp/connectors/${apiKeyConnector}/tools`, {
      method: "POST",
      headers: { authorization: `Bearer ${INTERNAL_KEY}`, "kobe-sandbox-token": token },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(KEY);
  });
});

describe("pinning stays an install admin's action", () => {
  const tools = [{ name: "get_x", description: "d", inputSchema: { type: "object" } }];
  const hash = async (id: string) =>
    (await h.admin.query(`SELECT tools_hash FROM connectors WHERE id = $1`, [id])).rows[0]
      .tools_hash as string | null;

  it("does not probe or pin when a member adds a key", async () => {
    const id = await connector("pinme", "api_key", [teamT]);
    probes.length = 0;
    probeAnswer = { ok: true, tools };
    const res = await alice.put(`${BASE}/${id}`, { api_key: KEY });
    expect(res.status).toBe(201);
    expect(res.json).not.toHaveProperty("pin");
    expect(probes).toEqual([]);
    expect(await hash(id)).toBeNull();
  });

  it("re-pins with the admin's own grant, never another user's", async () => {
    const id = await connector("repin", "api_key", [teamT]);
    await alice.put(`${BASE}/${id}`, { api_key: KEY });
    const rootId = await h.createUser("root@grants.test", "admin");
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [teamT, rootId],
    );
    const root = await h.signIn("root@grants.test");
    expect((await root.put("/v1/me/teams/active", { teamId: teamT })).status).toBe(200);
    root.team = teamT;
    probes.length = 0;
    probeAnswer = { ok: false, failure: "auth_required" };

    // The admin has no key of their own yet: alice's key is not used.
    await root.post(`/v1/install/connectors/${id}/pin`);
    expect(probes).toEqual([{ url: "https://mcp.example.com/mcp", apiKey: undefined }]);

    // With their own grant, that key (and no other) is used, and the pin lands.
    expect((await root.put(`${BASE}/${id}`, { api_key: KEY2 })).status).toBe(201);
    expect(probes).toHaveLength(1);
    probes.length = 0;
    probeAnswer = { ok: true, tools };
    const pinned = await root.post(`/v1/install/connectors/${id}/pin`);
    expect(pinned.status, pinned.text).toBe(200);
    expect(probes).toEqual([{ url: "https://mcp.example.com/mcp", apiKey: KEY2 }]);
    expect(pinned.text).not.toContain(KEY2);
    expect(pinned.text).not.toContain(KEY);
    expect(await hash(id)).toMatch(/^[0-9a-f]{64}$/);
  });
});
