import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnvelope } from "@kobe/db";
import { logger } from "./logger.js";
import { createInternalApp } from "./routes/internal.js";
import type { TestBrowser } from "./testing/browser.js";
import { FakeOauthServer } from "./testing/fake-oauth-server.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { grantContext, revealCredential } from "./connectors/grants.js";
import { parseOauthBundle, serializeOauthBundle } from "./connectors/oauth/bundle.js";
import { RefreshGate } from "./connectors/oauth/refresh-gate.js";
import { INTERNAL_KEY, MCP_SESSION_KEY, mcpToken } from "./testing/mcp-fixtures.js";

/**
 * OAuth grant refresh, revoke and suspension (KOBE-110): rotating refresh tokens are used once
 * even across concurrent callers, a rejected refresh needs a reconnect, a revoke or a deactivated
 * user stops the very next credential reveal, and nothing secret reaches audit rows or logs.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const BASE = "/v1/connector-grants";
const team = randomUUID();
const fake = new FakeOauthServer();
let h: Harness;
let alice: TestBrowser;
let aliceId = "";
let connectorId = "";
let internal: ReturnType<typeof createInternalApp>;
const logged: string[] = [];

beforeAll(async () => {
  await fake.start();
  for (const level of ["info", "warn", "error", "debug"] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => void)(...args);
    }) as never);
  }
  h = await openHarness({
    envelope: must(loadEnvelope({ KOBE_ENVELOPE_KEY: "f".repeat(48) })),
    connectors: {
      allowHttp: true,
      allowedPorts: [fake.port],
      allowedInternalCidrs: ["127.0.0.0/8"],
    },
  });
  aliceId = await h.createUser("alice@refresh.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'r', 'r')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, aliceId],
  );
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO connectors (name, url, auth_kind) VALUES ($1, $2, 'oauth') RETURNING id`,
    [`refresh-${randomUUID().slice(0, 6)}`, fake.mcpUrl],
  );
  connectorId = must(rows[0]).id;
  await h.admin.query(
    `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
    [team, connectorId, aliceId],
  );
  alice = await h.signIn("alice@refresh.test");
  await alice.put("/v1/me/teams/active", { teamId: team });
  alice.team = team;
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
  await fake.close();
});

const grantFor = async () => {
  const res = await internal.request(`/internal/v1/mcp/connectors/${connectorId}/grant`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${INTERNAL_KEY}`,
      "kobe-sandbox-token": mcpToken({ sandboxId: randomUUID(), teamId: team, userId: aliceId }),
    },
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
};

/** Connects alice through the fake authorization server; returns the tokens issued. */
async function connect() {
  const started = await alice.post(`${BASE}/${connectorId}/oauth/start`);
  const url = (started.json as { authorization_url: string }).authorization_url;
  const back = await fake.authorize(url);
  const done = await alice.get(`${BASE}/oauth/callback${back.search}`);
  expect(done.headers.get("location")).toContain("connected");
  return must(fake.issued.at(-1));
}
const expire = () =>
  h.admin.query(`UPDATE connector_grants SET expires_at = now() - interval '1 minute'`);
/** The reveal itself, without the internal API's own sandbox-token liveness checks in front. */
const reveal = async () =>
  (
    await h.deps.mcp.revealCredential(
      { sandboxId: randomUUID(), teamId: team, userId: aliceId },
      connectorId,
    )
  ).ok;
const db = () => h.deps.database.db;
const envelope = () => must(h.deps.envelope);
const subject = () => ({ teamId: team, userId: aliceId, connectorId });
/** One more "replica": its own gate, same database and authorization server. */
const replica = (gate = new RefreshGate()) => ({
  io: { policy: h.deps.connectorUrlPolicy, timeoutMs: 10_000 },
  gate,
});
const as = async (r: Promise<{ ok: boolean }>) => (await r).ok;
const disconnect = () => alice.delete(`${BASE}/${connectorId}`);
const auditText = async () =>
  JSON.stringify((await h.admin.query(`SELECT action, target FROM audit_log`)).rows);

describe("refreshing an expired access token", () => {
  it("uses the refresh token, rotates it and serves the new access token", async () => {
    const first = await connect();
    expect((await grantFor()).body).toEqual({ kind: "oauth", access_token: first.accessToken });
    expect(fake.refreshRequests).toHaveLength(0);

    await expire();
    const served = await grantFor();
    expect(served.status).toBe(200);
    const second = must(fake.issued.at(-1));
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(served.body).toEqual({ kind: "oauth", access_token: second.accessToken });
    const req = must(fake.refreshRequests[0]);
    expect(req.get("refresh_token")).toBe(first.refreshToken);
    expect(req.get("resource")).toBe(fake.mcpUrl);

    // The rotated refresh token was stored: the next expiry refreshes again, with the new one.
    await expire();
    expect((await grantFor()).status).toBe(200);
    expect(must(fake.refreshRequests[1]).get("refresh_token")).toBe(second.refreshToken);
    const { rows } = await h.admin.query<{ expires_at: Date; sealed: string }>(
      `SELECT expires_at, sealed FROM connector_grants`,
    );
    expect(must(rows[0]).expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(must(rows[0]).sealed).not.toContain(second.refreshToken);
  });

  it("refreshes a token that is about to expire, not only one that has", async () => {
    const before = fake.refreshRequests.length;
    await h.admin.query(`UPDATE connector_grants SET expires_at = now() + interval '5 seconds'`);
    expect((await grantFor()).status).toBe(200);
    expect(fake.refreshRequests.length).toBe(before + 1);
  });

  it("serializes concurrent callers: one refresh, one rotation, same token for all", async () => {
    fake.options = { ...fake.options, refreshDelayMs: 150 };
    await expire();
    const before = fake.refreshRequests.length;
    const results = await Promise.all(Array.from({ length: 6 }, () => grantFor()));
    fake.options = { ...fake.options, refreshDelayMs: 0 };
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(fake.refreshRequests.length).toBe(before + 1);
    expect(new Set(results.map((r) => r.body.access_token)).size).toBe(1);
    expect(results[0]?.body.access_token).toBe(must(fake.issued.at(-1)).accessToken);
  });

  it("keeps the grant when the authorization server is down, backs off, and recovers", async () => {
    await expire();
    const gate = new RefreshGate({ backoffMs: 400 });
    const direct = () => revealCredential(db(), envelope(), subject(), new Date(), replica(gate));
    fake.options = { ...fake.options, refreshUnavailable: true };
    const before = fake.refreshRequests.length;
    expect((await direct()).ok).toBe(false);
    expect((await direct()).ok).toBe(false);
    expect(fake.refreshRequests.length).toBe(before + 1); // the second call backed off
    fake.options = { ...fake.options, refreshUnavailable: false };
    await new Promise((r) => setTimeout(r, 450));
    expect((await direct()).ok).toBe(true);
  });

  it("treats invalid_grant as needs-reconnect: grant dropped, audited, no secrets", async () => {
    const tokens = must(fake.issued.at(-1));
    await expire();
    fake.options = { ...fake.options, refreshRejects: true };
    expect((await grantFor()).status).toBe(404);
    fake.options = { ...fake.options, refreshRejects: false };
    expect((await alice.get(BASE)).json).toEqual({ grants: [] });
    const audit = await auditText();
    expect(audit).toContain("mcp.grant.refresh_failed");
    for (const secret of [tokens.accessToken, tokens.refreshToken]) {
      expect(audit).not.toContain(secret);
      expect(JSON.stringify(logged)).not.toContain(secret);
    }
  });
});

describe("refresh does not hold the database (compare-and-set)", () => {
  const busy = () => h.deps.database.pool.totalCount - h.deps.database.pool.idleCount;

  it("8 concurrent reveals against a hanging token endpoint: one HTTP call, no connection held", async () => {
    await connect();
    await expire();
    fake.options = { ...fake.options, refreshDelayMs: 600 };
    const before = fake.refreshRequests.length;
    const calls = Array.from({ length: 8 }, () => grantFor());
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.refreshRequests.length).toBe(before + 1);
    expect(busy()).toBe(0);
    // The pool is free for other work while the authorization server hangs.
    expect((await alice.get(BASE)).status).toBe(200);
    const results = await Promise.all(calls);
    fake.options = { ...fake.options, refreshDelayMs: 0 };
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.access_token)).size).toBe(1);
  });

  it("two replicas race: one wins, the other serves the winner's token", async () => {
    await expire();
    fake.options = { ...fake.options, refreshDelayMs: 150 };
    const [a, b] = await Promise.all([
      revealCredential(db(), envelope(), subject(), new Date(), replica()),
      revealCredential(db(), envelope(), subject(), new Date(), replica()),
    ]);
    fake.options = { ...fake.options, refreshDelayMs: 0 };
    const winner = must(fake.issued.at(-1)).accessToken;
    for (const r of [a, b]) {
      expect(r).toEqual({ ok: true, credential: { kind: "oauth", accessToken: winner } });
    }
    expect((await alice.get(BASE)).json).toMatchObject({ grants: [{ connector_id: connectorId }] });
  });

  it("a revoke during an in-flight refresh leaves the grant deleted", async () => {
    await expire();
    fake.options = { ...fake.options, refreshDelayMs: 300 };
    const flight = revealCredential(db(), envelope(), subject(), new Date(), replica());
    await new Promise((r) => setTimeout(r, 100));
    expect((await disconnect()).status).toBe(204);
    expect(await as(flight)).toBe(false);
    fake.options = { ...fake.options, refreshDelayMs: 0 };
    const { rows } = await h.admin.query(`SELECT 1 FROM connector_grants`);
    expect(rows).toHaveLength(0);
  });

  it("invalid_grant after another replica rotated the grant does not drop it", async () => {
    await connect();
    await expire();
    fake.options = { ...fake.options, refreshRejects: true, refreshDelayMs: 300 };
    const flight = revealCredential(db(), envelope(), subject(), new Date(), replica());
    await new Promise((r) => setTimeout(r, 100));
    // Another replica stores a rotated bundle while this one waits.
    const { rows } = await h.admin.query<{ sealed: string }>(`SELECT sealed FROM connector_grants`);
    const ctx = grantContext(team, aliceId, connectorId);
    const bundle = parseOauthBundle(envelope().openString(must(rows[0]).sealed, ctx));
    const rotated = envelope().seal(
      serializeOauthBundle({ ...bundle, access_token: "rotated-by-other-replica" }),
      ctx,
    );
    await h.admin.query(
      `UPDATE connector_grants SET sealed = $1, expires_at = now() + interval '1 hour'`,
      [rotated],
    );
    const result = await flight;
    fake.options = { ...fake.options, refreshRejects: false, refreshDelayMs: 0 };
    expect(result).toEqual({
      ok: true,
      credential: { kind: "oauth", accessToken: "rotated-by-other-replica" },
    });
    expect((await h.admin.query(`SELECT 1 FROM connector_grants`)).rows).toHaveLength(1);
    await disconnect();
  });
});

describe("revocation and suspension", () => {
  it("a revoke stops the next reveal immediately (ac-1)", async () => {
    await connect();
    expect((await grantFor()).status).toBe(200);
    expect((await disconnect()).status).toBe(204);
    expect((await grantFor()).status).toBe(404);
  });

  it("a revoke waits for an in-flight refresh and then wins", async () => {
    await connect();
    await expire();
    fake.options = { ...fake.options, refreshDelayMs: 200 };
    const reveal = grantFor();
    await new Promise((r) => setTimeout(r, 50));
    const revoke = disconnect();
    expect((await revoke).status).toBe(204);
    await reveal;
    fake.options = { ...fake.options, refreshDelayMs: 0 };
    expect((await grantFor()).status).toBe(404);
  });

  it("a deactivated user's grant stops working at reveal time (ac-2), and returns on reactivation", async () => {
    await connect();
    expect(await reveal()).toBe(true);
    await h.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [aliceId]);
    expect(await reveal()).toBe(false);
    expect((await grantFor()).status).toBeGreaterThanOrEqual(401);
    await expire();
    const before = fake.refreshRequests.length;
    expect(await reveal()).toBe(false);
    expect(fake.refreshRequests.length).toBe(before);
    expect(await auditText()).toContain("user_inactive");
    await h.admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [aliceId]);
    expect(await reveal()).toBe(true);
  });

  it("a user removed from the team, or a disabled connector, serves nothing", async () => {
    await h.admin.query(`DELETE FROM team_members WHERE user_id = $1`, [aliceId]);
    expect(await reveal()).toBe(false);
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [team, aliceId],
    );
    expect(await reveal()).toBe(true);
    await h.admin.query(`UPDATE connectors SET status = 'disabled' WHERE id = $1`, [connectorId]);
    expect(await reveal()).toBe(false);
    expect((await grantFor()).status).toBe(404);
    await h.admin.query(`UPDATE connectors SET status = 'active' WHERE id = $1`, [connectorId]);
    expect(await reveal()).toBe(true);
  });
});
