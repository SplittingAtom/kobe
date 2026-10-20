import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnvelope } from "@kobe/db";
import type { ProbeResult } from "./connectors/probe.js";
import { refreshConnector } from "./connectors/refresh.js";
import { logger } from "./logger.js";
import { createInternalApp } from "./routes/internal.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { signSessionToken } from "@kobe/session-token";
import {
  INTERNAL_KEY,
  MCP_SESSION_KEY,
  leaseRun,
  mcpToken,
  activeSandbox,
} from "./testing/mcp-fixtures.js";

/**
 * A site-wide API key for an MCP connector (KOBE-303): a site admin sets one key, every member of
 * a team that enabled the connector uses it with no setup, members cannot add their own, and the
 * key never reaches an API response, an audit row or a log line. Probes (pin, refresh) use it.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const BASE = "/v1/site/connectors";
const SITE_KEY = "site-key-AbCdEf0123456789XyZ";
const SITE_KEY2 = "site-key-Second0123456789QwE";
const MEMBER_KEY = "member-key-0123456789abcdefg";
const teamOn = randomUUID();
const teamOff = randomUUID();
let h: Harness;
let root: TestBrowser;
let alice: TestBrowser;
let rootId = "";
let aliceId = "";
let bobId = "";
let carolId = "";
let internal: ReturnType<typeof createInternalApp>;
const probedKeys: (string | undefined)[] = [];
const logged: string[] = [];
const tools = [
  {
    name: "lookup",
    description: "d",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
];

const answer = (key: string | undefined): ProbeResult =>
  key === SITE_KEY || key === SITE_KEY2
    ? { ok: true, tools }
    : { ok: false, failure: "auth_required" };

beforeAll(async () => {
  for (const level of ["info", "warn", "error", "debug"] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => void)(...args);
    }) as never);
  }
  h = await openHarness({
    envelope: must(loadEnvelope({ KOBE_ENVELOPE_KEY: "s".repeat(48) })),
    connectors: { resolve: async () => ["93.184.216.34"] },
    connectorProbe: {
      probe: async (_url, apiKey) => {
        probedKeys.push(apiKey);
        return answer(apiKey);
      },
    },
  });
  rootId = await h.createUser("root@sitekey.test", "admin");
  aliceId = await h.createUser("alice@sitekey.test");
  bobId = await h.createUser("bob@sitekey.test");
  carolId = await h.createUser("carol@sitekey.test");
  for (const [id, slug] of [
    [teamOn, "on"],
    [teamOff, "off"],
  ] as const) {
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  }
  for (const [team, user] of [
    [teamOn, aliceId],
    [teamOn, bobId],
    [teamOff, carolId],
  ] as const) {
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [team, user],
    );
  }
  root = await h.signIn("root@sitekey.test");
  alice = await h.signIn("alice@sitekey.test");
  await alice.put("/v1/me/teams/active", { teamId: teamOn });
  alice.team = teamOn;
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
  vi.restoreAllMocks();
  await h?.close();
});

const grantFor = async (team: string, user: string, connectorId: string) => {
  const token = mcpToken({
    sandboxId: await activeSandbox(h.admin, team, user),
    teamId: team,
    userId: user,
  });
  const res = await internal.request(`/internal/v1/mcp/connectors/${connectorId}/grant`, {
    method: "POST",
    headers: { authorization: `Bearer ${INTERNAL_KEY}`, "kobe-sandbox-token": token },
  });
  return { status: res.status, body: JSON.parse(await res.text()) as Record<string, string> };
};
const enable = (team: string, connectorId: string) =>
  h.admin.query(
    `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
    [team, connectorId, rootId],
  );
const auditText = async () =>
  JSON.stringify((await h.admin.query(`SELECT action, target FROM audit_log`)).rows);
const siteKeyRow = async (id: string) =>
  (
    await h.admin.query(
      `SELECT sealed, key_id, hint FROM connector_site_keys WHERE connector_id = $1`,
      [id],
    )
  ).rows[0] as { sealed: string; key_id: string; hint: string } | undefined;

/** A site-key connector enabled for `teamOn`, with SITE_KEY set (and so pinned). */
async function siteConnector(name: string): Promise<string> {
  const created = await root.post(BASE, {
    name,
    url: `https://${name}.example/mcp`,
    authKind: "api_key",
    credentialSource: "site",
  });
  expect(created.status, created.text).toBe(201);
  const id = created.json.connector.id as string;
  expect(created.json.connector).toMatchObject({ credentialSource: "site", siteKeyHint: null });
  await enable(teamOn, id);
  const set = await root.put(`${BASE}/${id}/site-key`, { api_key: SITE_KEY });
  expect(set.status, set.text).toBe(200);
  return id;
}

describe("setting the key (ac-1, ac-2)", () => {
  it("seals the key, shows only a masked hint and pins the tools with it", async () => {
    probedKeys.length = 0;
    const id = await siteConnector("site-a");
    expect(probedKeys).toEqual([undefined, SITE_KEY]);
    const view = (await root.get(`${BASE}/${id}`)).json.connector;
    expect(view).toMatchObject({
      credentialSource: "site",
      siteKeyHint: `••••${SITE_KEY.slice(-4)}`,
      toolCount: 1,
    });
    const row = must(await siteKeyRow(id));
    expect(row.sealed).toMatch(/^e1\./);
    expect(row.sealed).not.toContain(SITE_KEY);
    expect(row.key_id.length).toBeGreaterThan(0);

    const listed = await root.get(BASE);
    expect(listed.text).not.toContain(SITE_KEY);
    expect(listed.text).not.toContain(row.sealed);
    const events = await h.admin.query(
      `SELECT action, actor_id, target FROM audit_log
        WHERE target->>'connectorId' = $1 AND action LIKE 'mcp.connector.site_key%'`,
      [id],
    );
    expect(events.rows).toEqual([
      {
        action: "mcp.connector.site_key_set",
        actor_id: rootId,
        target: { connectorId: id, name: "site-a", replaced: false },
      },
    ]);
    const choice = await h.admin.query(
      `SELECT target FROM audit_log WHERE action = 'mcp.connector.probe_credential'
        AND target->>'connectorId' = $1 ORDER BY seq DESC LIMIT 1`,
      [id],
    );
    expect(choice.rows[0]?.target).toMatchObject({ purpose: "pin", credential: "site_key" });
  });

  it("refuses a site key on a per-member connector, and on a non-api_key connector", async () => {
    const member = await root.post(BASE, {
      name: "site-member",
      url: "https://site-member.example/mcp",
      authKind: "api_key",
    });
    expect(member.json.connector.credentialSource).toBe("member");
    const put = await root.put(`${BASE}/${member.json.connector.id}/site-key`, {
      api_key: SITE_KEY,
    });
    expect(put.status).toBe(409);
    expect(put.json.code).toBe("not_site_key");
    const oauth = await root.post(BASE, {
      name: "site-oauth",
      url: "https://site-oauth.example/mcp",
      authKind: "oauth",
      credentialSource: "site",
    });
    expect(oauth.status).toBe(400);
  });

  it("is for site admins only", async () => {
    const id = await siteConnector("site-b");
    expect((await alice.put(`${BASE}/${id}/site-key`, { api_key: SITE_KEY2 })).status).toBe(403);
    expect((await alice.delete(`${BASE}/${id}/site-key`)).status).toBe(403);
  });
});

describe("members use it (ac-3, ac-5)", () => {
  it("serves the site key to every member of an enabled team, none to other teams", async () => {
    const id = await siteConnector("site-c");
    expect(await grantFor(teamOn, aliceId, id)).toEqual({
      status: 200,
      body: { kind: "api_key", api_key: SITE_KEY },
    });
    expect((await grantFor(teamOn, bobId, id)).body).toEqual({
      kind: "api_key",
      api_key: SITE_KEY,
    });
    expect((await grantFor(teamOff, carolId, id)).status).toBe(404);

    // Members see it provided and cannot add their own key.
    const listed = (await alice.get("/v1/team/connectors")).json.connectors as {
      id: string;
      credential_source: string;
      site_key_ready: boolean;
    }[];
    expect(listed.find((c) => c.id === id)).toMatchObject({
      credential_source: "site",
      site_key_ready: true,
    });
    const own = await alice.put(`/v1/connector-grants/${id}`, { api_key: MEMBER_KEY });
    expect(own.status).toBe(409);
    expect(own.json.code).toBe("provided_by_site");
  });

  it("replacing or removing the key takes effect on the next call", async () => {
    const id = await siteConnector("site-d");
    const replaced = await root.put(`${BASE}/${id}/site-key`, { api_key: SITE_KEY2 });
    expect(replaced.status).toBe(200);
    expect((await grantFor(teamOn, aliceId, id)).body.api_key).toBe(SITE_KEY2);
    expect((await root.delete(`${BASE}/${id}/site-key`)).status).toBe(204);
    expect((await grantFor(teamOn, aliceId, id)).status).toBe(404);
    expect((await root.delete(`${BASE}/${id}/site-key`)).status).toBe(404);
    expect((await root.get(`${BASE}/${id}`)).json.connector.siteKeyHint).toBeNull();
    const actions = await h.admin.query(
      `SELECT action, target FROM audit_log WHERE target->>'connectorId' = $1
        AND action LIKE 'mcp.connector.site_key%' ORDER BY seq`,
      [id],
    );
    expect(actions.rows.map((r) => [r.action, r.target.replaced ?? r.target.reason])).toEqual([
      ["mcp.connector.site_key_set", false],
      ["mcp.connector.site_key_set", true],
      ["mcp.connector.site_key_removed", "removed"],
    ]);
  });

  it("stops a deactivated member's calls at once", async () => {
    const id = await siteConnector("site-e");
    await h.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [bobId]);
    // The sandbox token is refused first; the reveal itself refuses too.
    const res = await grantFor(teamOn, bobId, id);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(SITE_KEY);
    const revealed = await h.deps.mcp.revealCredential(
      { sandboxId: await activeSandbox(h.admin, teamOn, bobId), teamId: teamOn, userId: bobId },
      id,
    );
    expect(revealed).toEqual({ ok: false, failure: "not_available" });
    await h.admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [bobId]);
  });
});

describe("changing the connector", () => {
  it("member → site drops members' own keys; site → member drops the site key", async () => {
    const created = await root.post(BASE, {
      name: "site-switch",
      url: "https://site-switch.example/mcp",
      authKind: "api_key",
    });
    const id = created.json.connector.id as string;
    await enable(teamOn, id);
    expect((await alice.put(`/v1/connector-grants/${id}`, { api_key: MEMBER_KEY })).status).toBe(
      201,
    );
    const toSite = await root.patch(`${BASE}/${id}`, { credentialSource: "site" });
    expect(toSite.json.connector.credentialSource).toBe("site");
    const grants = await h.admin.query(`SELECT 1 FROM connector_grants WHERE connector_id = $1`, [
      id,
    ]);
    expect(grants.rows).toHaveLength(0);
    await root.put(`${BASE}/${id}/site-key`, { api_key: SITE_KEY });
    expect(await siteKeyRow(id)).toBeDefined();

    const toMember = await root.patch(`${BASE}/${id}`, { credentialSource: "member" });
    expect(toMember.json.connector).toMatchObject({
      credentialSource: "member",
      siteKeyHint: null,
    });
    expect(await siteKeyRow(id)).toBeUndefined();
    expect((await grantFor(teamOn, aliceId, id)).status).toBe(404);
  });

  it("a new URL or another auth kind drops the site key", async () => {
    const id = await siteConnector("site-url");
    await root.patch(`${BASE}/${id}`, { url: "https://site-url-2.example/mcp" });
    expect(await siteKeyRow(id)).toBeUndefined();
    await root.put(`${BASE}/${id}/site-key`, { api_key: SITE_KEY });
    const oauth = await root.patch(`${BASE}/${id}`, { authKind: "oauth" });
    expect(oauth.json.connector).toMatchObject({ authKind: "oauth", credentialSource: "member" });
    expect(await siteKeyRow(id)).toBeUndefined();
    const reasons = await h.admin.query(
      `SELECT target->>'reason' AS reason FROM audit_log
        WHERE action = 'mcp.connector.site_key_removed' AND target->>'connectorId' = $1 ORDER BY seq`,
      [id],
    );
    expect(reasons.rows.map((r) => r.reason)).toEqual(["url_changed", "mode_changed"]);
  });
});

describe("the refresh probes with the site key", () => {
  it("prefers the site key over any admin's key", async () => {
    const id = await siteConnector("site-refresh");
    probedKeys.length = 0;
    expect(
      await refreshConnector(h.deps.database.db, h.deps.connectorProbe, id, {
        envelope: h.deps.envelope,
      }),
    ).toEqual({ status: "unchanged" });
    expect(probedKeys).toEqual([SITE_KEY]);
  });
});

/** What a member's `/v1/team/connectors` says about the connector's site key (KOBE-449). */
async function siteKeyReady(id: string): Promise<boolean | undefined> {
  const listed = (await alice.get("/v1/team/connectors")).json.connectors as {
    id: string;
    site_key_ready: boolean;
  }[];
  return listed.find((c) => c.id === id)?.site_key_ready;
}

describe("review follow-ups", () => {
  it("serves no key once the URL changed outside the registry, and says to re-enter it (M2)", async () => {
    const id = await siteConnector("site-bound");
    expect((await grantFor(teamOn, aliceId, id)).status).toBe(200);
    // An older release's edit: the URL changes and the key row stays.
    await h.admin.query(
      `UPDATE connectors SET url = 'https://elsewhere.example/mcp' WHERE id = $1`,
      [id],
    );
    expect(await siteKeyRow(id)).toBeDefined();
    expect((await grantFor(teamOn, aliceId, id)).status).toBe(404);
    // Members are not told it is provided while the key is stale (KOBE-449).
    expect(await siteKeyReady(id)).toBe(false);
    probedKeys.length = 0;
    await refreshConnector(h.deps.database.db, h.deps.connectorProbe, id, {
      envelope: h.deps.envelope,
    });
    expect(probedKeys).toEqual([undefined]);
    expect((await root.get(`${BASE}/${id}`)).json.connector).toMatchObject({
      siteKeyStale: true,
    });
    // Re-entered for the new URL, it is served again.
    await root.put(`${BASE}/${id}/site-key`, { api_key: SITE_KEY2 });
    expect((await grantFor(teamOn, aliceId, id)).body.api_key).toBe(SITE_KEY2);
    expect((await root.get(`${BASE}/${id}`)).json.connector.siteKeyStale).toBe(false);
    expect(await siteKeyReady(id)).toBe(true);
    await root.delete(`${BASE}/${id}/site-key`);
    expect(await siteKeyReady(id)).toBe(false);
  });

  it("gives a skill eval's sandbox no site key (test 3)", async () => {
    const id = await siteConnector("site-eval");
    const now = Math.floor(Date.now() / 1000);
    const token = signSessionToken(
      {
        iss: "kobe-server",
        aud: "kobe.mcp-proxy",
        sub: randomUUID(),
        team_id: teamOn,
        user_id: aliceId,
        eval_thread: randomUUID(),
        iat: now,
        exp: now + 600,
        jti: `test-${randomUUID()}`,
      },
      MCP_SESSION_KEY,
    );
    const res = await internal.request(`/internal/v1/mcp/connectors/${id}/grant`, {
      method: "POST",
      headers: { authorization: `Bearer ${INTERNAL_KEY}`, "kobe-sandbox-token": token },
    });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ code: "not_connected" });
    expect(body).not.toContain(SITE_KEY);
  });

  it("a scheduled run calls it with the site key, decided and audited as the member (test 4)", async () => {
    const id = await siteConnector("site-sched");
    const sandboxId = randomUUID();
    const threadId = randomUUID();
    const runId = randomUUID();
    await h.admin.query(
      `INSERT INTO threads (team_id, id, owner_user_id, status) VALUES ($1, $2, $3, 'running')`,
      [teamOn, threadId, aliceId],
    );
    await h.admin.query(
      `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, $3, 'schedule', 'running', now())`,
      [teamOn, runId, threadId],
    );
    await leaseRun(h.admin, teamOn, runId, aliceId, sandboxId);
    const token = mcpToken({ sandboxId, teamId: teamOn, userId: aliceId });
    const res = await internal.request(`/internal/v1/mcp/connectors/${id}/calls`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${INTERNAL_KEY}`,
        "kobe-sandbox-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tool: "lookup", arguments: {}, thread_id: threadId }),
    });
    expect(await res.json()).toMatchObject({ decision: "allow" });
    const grant = await internal.request(`/internal/v1/mcp/connectors/${id}/grant`, {
      method: "POST",
      headers: { authorization: `Bearer ${INTERNAL_KEY}`, "kobe-sandbox-token": token },
    });
    expect(await grant.json()).toEqual({ kind: "api_key", api_key: SITE_KEY });
    const audited = await h.admin.query(
      `SELECT actor_id, target FROM audit_log WHERE action = 'mcp.tool_call'
        AND target->>'connectorId' = $1`,
      [id],
    );
    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0]).toMatchObject({
      actor_id: aliceId,
      target: { userId: aliceId, decision: "allowed", runId },
    });
  });

  it("refuses a member removed from the team (test 5)", async () => {
    const id = await siteConnector("site-left");
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      teamOn,
      bobId,
    ]);
    expect((await grantFor(teamOn, bobId, id)).status).toBe(401);
    const revealed = await h.deps.mcp.revealCredential(
      { sandboxId: await activeSandbox(h.admin, teamOn, bobId), teamId: teamOn, userId: bobId },
      id,
    );
    expect(revealed).toEqual({ ok: false, failure: "not_available" });
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [teamOn, bobId],
    );
  });

  it("refuses site mode on a connector that is not api_key with a clear 400 (L4)", async () => {
    const created = await root.post(BASE, {
      name: "site-oauth-patch",
      url: "https://site-oauth-patch.example/mcp",
      authKind: "oauth",
    });
    const res = await root.patch(`${BASE}/${created.json.connector.id}`, {
      credentialSource: "site",
    });
    expect(res.status).toBe(400);
    expect(res.json.message).toMatch(/API-key connectors only/);
  });
});

describe("the key goes nowhere else (ac-4)", () => {
  it("is in no audit row, no log line and no response", async () => {
    const text = await auditText();
    for (const secret of [SITE_KEY, SITE_KEY2]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(secret.slice(-4));
      expect(logged.join("\n")).not.toContain(secret);
    }
  });
});
