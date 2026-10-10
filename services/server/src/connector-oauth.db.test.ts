import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnvelope } from "@kobe/db";
import { logger } from "./logger.js";
import { createInternalApp } from "./routes/internal.js";
import type { TestBrowser } from "./testing/browser.js";
import { FakeOauthServer } from "./testing/fake-oauth-server.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { INTERNAL_KEY, MCP_SESSION_KEY, mcpToken } from "./testing/mcp-fixtures.js";

/**
 * Per-user OAuth grants (KOBE-109) against a fake authorization server following the MCP
 * 2026-07-28 authorization spec: discovery, PKCE S256, state bound to user/team/connector, resource
 * and iss checks, tokens sealed at rest and never returned or logged.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const BASE = "/v1/connector-grants";
const CALLBACK = `${BASE}/oauth/callback`;
const teamT = randomUUID();
const teamU = randomUUID();
const fake = new FakeOauthServer();
let h: Harness;
let alice: TestBrowser;
let bob: TestBrowser;
let carol: TestBrowser;
let aliceId = "";
let oauthConnector = "";
let keyConnector = "";
let internal: ReturnType<typeof createInternalApp>;
const logged: string[] = [];

async function connector(name: string, authKind: string, url: string, teams: string[]) {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO connectors (name, url, auth_kind) VALUES ($1, $2, $3) RETURNING id`,
    [`${name}-${randomUUID().slice(0, 6)}`, url, authKind],
  );
  const id = rows[0]?.id ?? "";
  for (const team of teams) {
    await h.admin.query(
      `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
      [team, id, aliceId],
    );
  }
  return id;
}

beforeAll(async () => {
  await fake.start();
  for (const level of ["info", "warn", "error", "debug"] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => void)(...args);
    }) as never);
  }
  const loaded = must(loadEnvelope({ KOBE_ENVELOPE_KEY: "e".repeat(48) }));
  h = await openHarness({
    envelope: loaded,
    connectors: {
      allowHttp: true,
      allowedPorts: [fake.port],
      allowedInternalCidrs: ["127.0.0.0/8"],
    },
  });
  aliceId = await h.createUser("alice@oauth.test");
  const bobId = await h.createUser("bob@oauth.test");
  const carolId = await h.createUser("carol@oauth.test");
  for (const [id, slug] of [
    [teamT, "t"],
    [teamU, "u"],
  ] as const) {
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  }
  for (const [team, user] of [
    [teamT, aliceId],
    [teamT, bobId],
    [teamU, carolId],
  ] as const) {
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [team, user],
    );
  }
  oauthConnector = await connector("oauthy", "oauth", fake.mcpUrl, [teamT]);
  keyConnector = await connector("keyed", "api_key", fake.mcpUrl, [teamT]);
  alice = await h.signIn("alice@oauth.test");
  bob = await h.signIn("bob@oauth.test");
  carol = await h.signIn("carol@oauth.test");
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
  vi.restoreAllMocks();
  await h?.close();
  await fake.close();
});

const start = (who: TestBrowser, connectorId = oauthConnector) =>
  who.post(`${BASE}/${connectorId}/oauth/start`);

/** Start + the browser round trip through the fake AS; returns the callback path and params. */
async function authorizeFor(who: TestBrowser, connectorId = oauthConnector) {
  const started = await start(who, connectorId);
  expect(started.status, started.text).toBe(200);
  const authorizationUrl = (started.json as { authorization_url: string }).authorization_url;
  const back = await fake.authorize(authorizationUrl);
  return { authorizationUrl: new URL(authorizationUrl), back, path: back.pathname + back.search };
}
const callbackPath = (back: URL) => `${CALLBACK}${back.search}`;

const grantFor = async (team: string, user: string, connectorId: string) => {
  const res = await internal.request(`/internal/v1/mcp/connectors/${connectorId}/grant`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${INTERNAL_KEY}`,
      "kobe-sandbox-token": mcpToken({ sandboxId: randomUUID(), teamId: team, userId: user }),
    },
  });
  return { status: res.status, text: await res.text() };
};

describe("connecting an OAuth connector", () => {
  it("runs the full flow and seals the tokens", async () => {
    const { authorizationUrl, back } = await authorizeFor(alice);
    const q = authorizationUrl.searchParams;
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${fake.base}/authorize`);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("resource")).toBe(fake.mcpUrl);
    expect(q.get("redirect_uri")).toBe(`http://kobe.test${CALLBACK}`);
    expect(q.get("scope")).toBe("tools");
    expect(q.get("state")?.length).toBeGreaterThan(40);
    expect(fake.registrations[0]).toMatchObject({
      redirect_uris: [`http://kobe.test${CALLBACK}`],
    });

    const done = await alice.get(callbackPath(back));
    expect(done.status, done.text).toBe(303);
    expect(done.headers.get("location")).toContain("connector_oauth=connected");

    // PKCE: the verifier Kobe sent at the token endpoint hashes to the challenge it announced.
    const token = fake.tokenRequests.at(-1);
    const verifier = token?.get("code_verifier") ?? "";
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(q.get("code_challenge"));
    expect(token?.get("resource")).toBe(fake.mcpUrl);
    expect(token?.get("redirect_uri")).toBe(`http://kobe.test${CALLBACK}`);

    const tokens = must(fake.issued.at(-1));
    const { rows } = await h.admin.query<{ kind: string; sealed: string; expires_at: Date }>(
      `SELECT kind, sealed, expires_at FROM connector_grants WHERE user_id = $1 AND connector_id = $2`,
      [aliceId, oauthConnector],
    );
    expect(rows[0]?.kind).toBe("oauth");
    expect(rows[0]?.sealed.startsWith("e1.")).toBe(true);
    expect(rows[0]?.sealed).not.toContain(tokens.accessToken);
    expect(rows[0]?.sealed).not.toContain(tokens.refreshToken);
    expect(rows[0]?.expires_at.getTime()).toBeGreaterThan(Date.now());

    const served = await grantFor(teamT, aliceId, oauthConnector);
    expect(served.status).toBe(200);
    expect(JSON.parse(served.text)).toEqual({ kind: "oauth", access_token: tokens.accessToken });
  });

  it("never returns or logs tokens, state secrets or the verifier", async () => {
    const tokens = must(fake.issued.at(-1));
    const list = await alice.get(BASE);
    expect(list.json).toMatchObject({
      grants: [{ connector_id: oauthConnector, kind: "oauth", hint: "••••" }],
    });
    const audit = await h.admin.query(`SELECT * FROM audit_log`);
    const verifier = fake.tokenRequests.at(-1)?.get("code_verifier") ?? "";
    const everything = JSON.stringify([list.text, audit.rows, logged]);
    for (const secret of [tokens.accessToken, tokens.refreshToken, verifier]) {
      expect(everything).not.toContain(secret);
    }
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(audit.rows.some((r) => JSON.stringify(r).includes("mcp.grant.added"))).toBe(true);
  });

  it("never serves another user's or another team's grant", async () => {
    const bobId =
      (
        await h.admin.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
          "bob@oauth.test",
        ])
      ).rows[0]?.id ?? "";
    expect((await grantFor(teamT, bobId, oauthConnector)).status).toBe(404);
    expect((await bob.get(BASE)).json).toEqual({ grants: [] });
    const carolId =
      (
        await h.admin.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
          "carol@oauth.test",
        ])
      ).rows[0]?.id ?? "";
    expect((await grantFor(teamU, carolId, oauthConnector)).status).toBe(404);
  });

  it("lets the owner remove the grant", async () => {
    expect((await alice.delete(`${BASE}/${oauthConnector}`)).status).toBe(204);
    expect((await grantFor(teamT, aliceId, oauthConnector)).status).toBe(404);
  });
});

describe("a connector pointed at another server", () => {
  const evil = "https://evil.example/mcp";
  it("never sends a token issued for the old server (refused and audited)", async () => {
    const { back } = await authorizeFor(alice);
    expect((await alice.get(callbackPath(back))).headers.get("location")).toContain("connected");
    const aliceUser = aliceId;
    expect((await grantFor(teamT, aliceUser, oauthConnector)).status).toBe(200);
    // A URL change that bypassed the registry (e.g. restored backup): the resource check holds.
    await h.admin.query(`UPDATE connectors SET url = $2 WHERE id = $1`, [oauthConnector, evil]);
    const served = await grantFor(teamT, aliceUser, oauthConnector);
    expect(served.status).toBe(503);
    expect(served.text).not.toContain(must(fake.issued.at(-1)).accessToken);
    const audit = await h.admin.query(
      `SELECT target FROM audit_log WHERE action = 'mcp.grant.refused'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain("at-secret");
    await h.admin.query(`UPDATE connectors SET url = $2 WHERE id = $1`, [
      oauthConnector,
      fake.mcpUrl,
    ]);
    await alice.delete(`${BASE}/${oauthConnector}`);
  });

  it("drops OAuth and API-key grants when the registry changes the URL", async () => {
    const { back } = await authorizeFor(alice);
    await alice.get(callbackPath(back));
    const bobUser = (
      await h.admin.query<{ id: string }>(`SELECT id FROM users WHERE email = 'bob@oauth.test'`)
    ).rows[0]?.id;
    expect((await bob.put(`${BASE}/${keyConnector}`, { api_key: "k".repeat(20) })).status).toBe(
      201,
    );
    const count = async () =>
      (await h.admin.query<{ n: string }>(`SELECT count(*) AS n FROM connector_grants`)).rows[0]?.n;
    expect(await count()).toBe("2");
    await h.createUser("root@oauth.test", "owner");
    const root = await h.signIn("root@oauth.test");
    for (const id of [oauthConnector, keyConnector]) {
      const res = await root.patch(`/v1/install/connectors/${id}`, { url: `${fake.base}/moved` });
      expect(res.status, res.text).toBe(200);
    }
    expect(await count()).toBe("0");
    expect(bobUser).toBeDefined();
    const removed = await h.admin.query(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'mcp.grant.removed'`,
    );
    expect(Number(removed.rows[0]?.n)).toBeGreaterThanOrEqual(2);
    for (const id of [oauthConnector, keyConnector]) {
      await h.admin.query(`UPDATE connectors SET url = $2 WHERE id = $1`, [id, fake.mcpUrl]);
    }
  });
});

describe("client metadata", () => {
  it("publishes Kobe's Client ID Metadata Document without a session", async () => {
    const res = await h.app.request("http://kobe.test/v1/oauth/client-metadata.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      client_id: "http://kobe.test/v1/oauth/client-metadata.json",
      redirect_uris: [`http://kobe.test${CALLBACK}`],
      token_endpoint_auth_method: "none",
    });
  });
});

describe("refusals", () => {
  it("refuses a state tampered with", async () => {
    const { back } = await authorizeFor(alice);
    back.searchParams.set("state", `${back.searchParams.get("state")}x`);
    const res = await alice.get(callbackPath(back));
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "invalid_state" });
  });

  it("refuses a state minted for another user", async () => {
    const { back } = await authorizeFor(alice);
    const res = await bob.get(callbackPath(back));
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "invalid_state" });
    expect((await bob.get(BASE)).json).toEqual({ grants: [] });
  });

  it("refuses a state used in another team", async () => {
    const { back } = await authorizeFor(alice);
    const res = await carol.get(callbackPath(back));
    expect(res.status).toBe(400);
  });

  it("refuses a callback without a state or with an unknown one", async () => {
    expect((await alice.get(`${CALLBACK}?code=abc`)).status).toBe(400);
    expect((await alice.get(`${CALLBACK}?code=abc&state=nonsense`)).status).toBe(400);
  });

  it("refuses a mismatching or missing iss (RFC 9207)", async () => {
    for (const iss of ["https://evil.example", null]) {
      const { back } = await authorizeFor(alice);
      if (iss === null) back.searchParams.delete("iss");
      else back.searchParams.set("iss", iss);
      const res = await alice.get(callbackPath(back));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("connector_oauth=failed");
    }
    expect((await alice.get(BASE)).json).toEqual({ grants: [] });
  });

  it("does not reuse an authorization code", async () => {
    const { back } = await authorizeFor(alice);
    expect((await alice.get(callbackPath(back))).headers.get("location")).toContain("connected");
    await alice.delete(`${BASE}/${oauthConnector}`);
    const replay = await alice.get(callbackPath(back));
    expect(replay.headers.get("location")).toContain("connector_oauth=failed");
    expect((await alice.get(BASE)).json).toEqual({ grants: [] });
  });

  it("shows an authorization error from the server without storing anything", async () => {
    const { back } = await authorizeFor(alice);
    const res = await alice.get(
      `${CALLBACK}?error=access_denied&state=${back.searchParams.get("state")}`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("connector_oauth=failed");
  });

  it("starts only for an enabled oauth connector", async () => {
    expect((await start(alice, keyConnector)).status).toBe(422);
    expect((await start(carol)).status).toBe(404);
    expect((await start(alice, randomUUID())).status).toBe(404);
    const putKey = await alice.put(`${BASE}/${oauthConnector}`, { api_key: "x".repeat(20) });
    expect(putKey.status).toBe(422);
  });
});

describe("discovery checks", () => {
  const reset = () => {
    fake.options = {};
  };
  it.each([
    ["no S256 support", { pkce: false }],
    ["a resource that is not the connector", { prmResource: "https://other.example/mcp" }],
    ["an issuer that differs from the server's", { metadataIssuer: "https://other.example" }],
  ])("refuses %s", async (_name, options) => {
    fake.options = options;
    try {
      const res = await start(alice);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "oauth_unsupported" });
    } finally {
      reset();
    }
  });

  it("answers a malformed issuer with oauth_unsupported, not an error", async () => {
    fake.options = { prmAuthServer: "http://[bad" };
    try {
      const res = await start(alice);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: "oauth_unsupported" });
    } finally {
      reset();
    }
  });

  it("fails without registration when the server offers none", async () => {
    fake.options = { dcr: false };
    try {
      expect((await start(alice)).status).toBe(422);
    } finally {
      reset();
    }
  });
});
