import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { endSsoSessionsWhenOff, seedHelmProviders } from "./sso/providers.js";
import { loadSsoSettings, type SsoSettings } from "./sso/settings.js";
import { resolver } from "./sso/testing.js";
import { TestBrowser } from "./testing/browser.js";
import { openHarness, PASSWORD, PUBLIC_URL, type Harness } from "./testing/harness.js";
import { MockOidcProvider, routeMockOidc } from "./testing/mock-oidc.js";
import { SoftwareAuthenticator } from "./testing/webauthn.js";

/**
 * KOBE-628 (spec sso-oidc-scim §5, §6, §9, §13; SSO10): OIDC sign-in end to end against an
 * in-process mock IdP — state/nonce/PKCE, ID token checks, JIT only with mapped access, never
 * linking on email, deactivated users, groups overage, session_sso_contexts, returnTo, the kill
 * switch, rate limits, and local break-glass sign-in with the IdP down.
 */
const TENANT = "11111111-2222-4333-8444-555555555555";
const ENTRA = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const KC = "https://kc.example.com/realms/kobe";
const CORP_SECRET = "Corp~Secret.Value-0123456789abcdef";
const KC_SECRET = "Kc~Secret.Value-0123456789abcdefgh";

const settingsFor = (enabled: "true" | "false"): SsoSettings =>
  loadSsoSettings({
    KOBE_SSO_ENABLED: enabled,
    KOBE_SSO_PROVIDERS: JSON.stringify([
      {
        slug: "corp",
        displayName: "Contoso",
        kind: "entra",
        tenantId: TENANT,
        clientId: "corp-app",
      },
      {
        slug: "kc",
        displayName: "Keycloak",
        kind: "oidc",
        issuer: KC,
        clientId: "kc-app",
        accessClaim: "groups",
      },
    ]),
    KOBE_SSO_CLIENT_SECRET_CORP: CORP_SECRET,
    KOBE_SSO_CLIENT_SECRET_KC: KC_SECRET,
  });

let h: Harness;
let entra: MockOidcProvider;
let kc: MockOidcProvider;
let owner: TestBrowser;
let ownerId = "";
let corpId = "";
let kcId = "";
let teamId = "";
let nextOid = 1;
const oid = () => `00000000-0000-4000-8000-${String(nextOid++).padStart(12, "0")}`;

beforeAll(async () => {
  entra = await MockOidcProvider.create({
    issuer: ENTRA,
    clientId: "corp-app",
    clientSecret: CORP_SECRET,
    tenantId: TENANT,
    // Entra supports S256 without advertising it; it also lists algorithms Kobe never accepts.
    discovery: {
      code_challenge_methods_supported: undefined,
      id_token_signing_alg_values_supported: ["RS256", "HS256", "none"],
    },
  });
  kc = await MockOidcProvider.create({
    issuer: KC,
    clientId: "kc-app",
    clientSecret: KC_SECRET,
    algorithm: "ES256",
  });
  const settings = settingsFor("true");
  h = await openHarness({
    sso: { settings, net: { resolve: resolver() }, request: routeMockOidc(entra, kc) },
  });
  await seedHelmProviders(h.deps.database.db, settings);
  ownerId = await h.createUser("owner@sso-signin.test", "owner");
  owner = await h.signIn("owner@sso-signin.test");
  const team = await owner.post("/v1/site/teams", {
    slug: "research",
    name: "Research",
    adminUserId: ownerId,
  });
  expect(team.status, JSON.stringify(team.json)).toBe(201);
  teamId = team.json.team.id;
  const { rows } = await h.admin.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM sso_providers`,
  );
  corpId = rows.find((r) => r.slug === "corp")?.id ?? "";
  kcId = rows.find((r) => r.slug === "kc")?.id ?? "";
  for (const [providerId, claimValue, role] of [
    [corpId, "kobe.research.member", "member"],
    [kcId, "g-research", "contributor"],
  ] as const) {
    const res = await owner.post(`/v1/site/sso/providers/${providerId}/mappings`, {
      claimValue,
      teamId,
      role,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
  }
});
afterAll(async () => {
  await h?.close();
});

interface Flow {
  readonly browser: TestBrowser;
  readonly startLocation: string;
  readonly callback: URL;
  readonly flowCookie: string;
}

/** Start in a fresh browser (own IP) and let the person sign in at the IdP. */
async function startAt(
  mock: MockOidcProvider,
  slug: string,
  user: Record<string, unknown>,
  returnTo?: string,
  browser = h.browser(),
): Promise<Flow> {
  const qs = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
  const start = await browser.get(`/api/auth/sso/start/${slug}${qs}`);
  expect(start.status, start.text).toBe(302);
  const startLocation = start.headers.get("location") ?? "";
  const flowCookie = browser.cookies.get("kobe-sso") ?? "";
  expect(flowCookie).not.toBe("");
  return { browser, startLocation, callback: mock.authorize(startLocation, user), flowCookie };
}

async function finish(flow: Flow, callback = flow.callback) {
  const res = await flow.browser.get(`${callback.pathname}${callback.search}`);
  expect(res.status, res.text).toBe(302);
  return { res, location: res.headers.get("location") ?? "" };
}

async function signInVia(
  mock: MockOidcProvider,
  slug: string,
  user: Record<string, unknown>,
  returnTo?: string,
) {
  const flow = await startAt(mock, slug, user, returnTo);
  return { ...(await finish(flow)), browser: flow.browser, flow };
}

const errorOf = (location: string) => new URL(location).searchParams.get("sso_error");
const entraUser = (over: Record<string, unknown> = {}) => {
  const id = oid();
  return {
    oid: id,
    sub: `pairwise-${id}`,
    name: "Ada Lovelace",
    preferred_username: `ada-${id}@contoso.com`,
    roles: ["kobe.research.member"],
    amr: ["pwd", "mfa"],
    acr: "1",
    auth_time: Math.floor(Date.now() / 1000) - 5,
    ...over,
  };
};

async function userCount(): Promise<number> {
  const { rows } = await h.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  return rows[0]?.n ?? 0;
}

async function failures(reason: string) {
  const { rows } = await h.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE action = 'auth.sign_in.failed'
       AND target ->> 'method' = 'sso' AND target ->> 'reason' = $1`,
    [reason],
  );
  return rows;
}

describe("sign-in page data", () => {
  it("lists the enabled providers by slug and name only", async () => {
    const res = await h.browser().get("/api/auth/sso/providers");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      providers: [
        { slug: "corp", displayName: "Contoso" },
        { slug: "kc", displayName: "Keycloak" },
      ],
    });
  });

  it("sends the browser to the IdP with code + PKCE S256, state and nonce", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const url = new URL(flow.startLocation);
    expect(url.origin + url.pathname).toBe(`${ENTRA.replace(/\/v2\.0$/, "")}/v2.0/authorize`);
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(p.get("nonce")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(p.get("redirect_uri")).toBe("http://kobe.test/api/auth/sso/callback/corp");
    expect(p.get("scope")).toBe("openid profile email");
    expect(p.get("prompt")).toBe("select_account");
    // The cookie carries no readable verifier, nonce or state.
    expect(flow.flowCookie).not.toContain(p.get("state") ?? "-");
    expect(flow.flowCookie).not.toContain(p.get("nonce") ?? "-");
  });
});

describe("JIT and linked sign-in", () => {
  it("creates a user for a mapped identity, signs them in and records the SSO context", async () => {
    const user = entraUser();
    const { location, browser } = await signInVia(entra, "corp", user, "/chat?x=1");
    expect(location).toBe("http://kobe.test/chat?x=1");
    const me = await browser.get("/v1/me");
    expect(me.status, me.text).toBe(200);
    expect(me.json.user.email).toBe(String(user.preferred_username));
    const userId = me.json.user.id as string;
    const link = await h.admin.query(
      `SELECT subject, linked_via, email_at_link FROM sso_identities WHERE user_id = $1`,
      [userId],
    );
    expect(link.rows).toEqual([
      { subject: user.oid, linked_via: "jit", email_at_link: user.preferred_username },
    ]);
    const member = await h.admin.query(
      `SELECT role, added_via FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId],
    );
    expect(member.rows).toEqual([{ role: "member", added_via: `idp:${corpId}` }]);
    const ctx = await h.admin.query(
      `SELECT c.provider_id, c.mfa_satisfied, c.amr, c.acr, c.auth_time
         FROM session_sso_contexts c JOIN sessions s ON s.id = c.session_id WHERE s.user_id = $1`,
      [userId],
    );
    expect(ctx.rows).toHaveLength(1);
    expect(ctx.rows[0]).toMatchObject({
      provider_id: corpId,
      mfa_satisfied: false,
      amr: ["pwd", "mfa"],
      acr: "1",
    });
    expect(new Date(ctx.rows[0].auth_time).getTime()).toBe(Number(user.auth_time) * 1000);
    const { rows: audit } = await h.admin.query<{ action: string; target: unknown }>(
      `SELECT action, target FROM audit_log WHERE actor_id = $1 ORDER BY seq`,
      [userId],
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["identity.sso.link.created", "auth.sign_in.succeeded"]),
    );
    expect(audit.find((a) => a.action === "auth.sign_in.succeeded")?.target).toEqual({
      method: "sso",
    });
    // No claim or token content in the audit log.
    expect(JSON.stringify(audit)).not.toContain("Ada Lovelace");
  });

  it("signs a linked identity in again without a second user, and keys on oid not email", async () => {
    const user = entraUser();
    await signInVia(entra, "corp", user);
    const before = await userCount();
    const again = await signInVia(entra, "corp", {
      ...user,
      preferred_username: "new@contoso.com",
    });
    expect(again.location).toBe("http://kobe.test/");
    expect(await userCount()).toBe(before);
    expect((await again.browser.get("/v1/me")).json.user.email).toBe(user.preferred_username);
  });

  it("gives an unmapped identity no user (no_access)", async () => {
    const before = await userCount();
    const { location, browser } = await signInVia(entra, "corp", entraUser({ roles: ["other"] }));
    expect(errorOf(location)).toBe("not_allowed");
    expect(new URL(location).pathname).toBe("/sign-in");
    expect(await userCount()).toBe(before);
    expect((await browser.get("/v1/me")).status).toBe(401);
    expect((await failures("no_access")).length).toBeGreaterThan(0);
  });

  it("refuses a linked person whose mapping no longer matches and who has no other access", async () => {
    const user = entraUser();
    await signInVia(entra, "corp", user);
    const { location, browser } = await signInVia(entra, "corp", { ...user, roles: [] });
    expect(errorOf(location)).toBe("not_allowed");
    expect((await browser.get("/v1/me")).status).toBe(401);
  });

  it("refuses a deactivated user", async () => {
    const user = entraUser();
    const first = await signInVia(entra, "corp", user);
    const userId = (await first.browser.get("/v1/me")).json.user.id as string;
    // Marked directly (no session cleanup), so only "no new session" is under test here.
    await h.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [userId]);
    const count = async () =>
      (await h.admin.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [userId])).rows.length;
    const before = await count();
    const { location, browser } = await signInVia(entra, "corp", user);
    expect(errorOf(location)).toBe("deactivated");
    expect((await browser.get("/v1/me")).status).toBe(401);
    expect(await count()).toBe(before);
  });

  it("never links an identity to a local user with the same email (link_required)", async () => {
    const localId = await h.createUser("grace@contoso.com");
    const before = await userCount();
    const { location, browser } = await signInVia(
      entra,
      "corp",
      entraUser({
        preferred_username: "Grace@Contoso.com",
        email: "grace@contoso.com",
        xms_edov: true,
      }),
    );
    expect(errorOf(location)).toBe("not_allowed");
    expect(await userCount()).toBe(before);
    expect((await browser.get("/v1/me")).status).toBe(401);
    const links = await h.admin.query(`SELECT 1 FROM sso_identities WHERE user_id = $1`, [localId]);
    expect(links.rows).toHaveLength(0);
    const sessions = await h.admin.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [localId]);
    expect(sessions.rows).toHaveLength(0);
    expect((await failures("link_required")).some((f) => f.target.userId === localId)).toBe(true);
  });

  it("replaces the browser's previous session (new session id at every sign-in)", async () => {
    const b = await h.signIn("owner@sso-signin.test");
    const { rows: before } = await h.admin.query<{ id: string }>(
      `SELECT id FROM sessions WHERE user_id = $1`,
      [ownerId],
    );
    const user = entraUser();
    const flow = await startAt(entra, "corp", user, undefined, b);
    await finish(flow);
    const { rows: after } = await h.admin.query<{ id: string }>(
      `SELECT id FROM sessions WHERE user_id = $1`,
      [ownerId],
    );
    expect(after.length).toBe(before.length - 1);
    expect((await b.get("/v1/me")).json.user.email).toBe(user.preferred_username);
  });

  it("sends no password-reset link to a user made by SSO (no local credential)", async () => {
    const user = entraUser();
    await signInVia(entra, "corp", user);
    const sent = h.mailer.sent.length;
    const res = await h.browser().post("/api/auth/request-password-reset", {
      email: user.preferred_username,
      redirectTo: "/reset-password",
    });
    expect(res.status).toBe(200);
    await h.deps.background.idle();
    expect(h.mailer.sent.length).toBe(sent);
  });
});

describe("team invitations need a verified address (nOAuth, review finding 1)", () => {
  async function invite(email: string, role: "member" | "team_admin" = "team_admin") {
    const admin = await h.signIn("owner@sso-signin.test");
    await admin.put("/v1/me/teams/active", { teamId });
    admin.team = teamId;
    const res = await admin.post("/v1/team/invites", { email, role });
    expect(res.status, res.text).toBeLessThan(300);
  }

  it("Entra: a self-set email claim never becomes the address (the UPN does)", async () => {
    await invite("victim1@kobe-victim.test");
    const { browser } = await signInVia(
      entra,
      "corp",
      entraUser({ email: "victim1@kobe-victim.test", preferred_username: "eve1@contoso.com" }),
    );
    const me = await browser.get("/v1/me");
    expect(me.json.user.email).toBe("eve1@contoso.com");
    expect((await browser.get("/v1/me/invites")).json.invitations).toEqual([]);
    expect((await browser.post(`/v1/me/invites/${teamId}/accept`)).status).toBe(404);
  });

  it("generic: an unverified email lists and accepts no invitation", async () => {
    await invite("victim2@kobe-victim.test");
    const { browser } = await signInVia(kc, "kc", {
      sub: "kc-nOAuth-1",
      email: "victim2@kobe-victim.test",
      groups: ["g-research"],
    });
    const me = await browser.get("/v1/me");
    expect(me.status, me.text).toBe(200);
    const userId = me.json.user.id as string;
    const row = await h.admin.query(`SELECT email, email_verified FROM users WHERE id = $1`, [
      userId,
    ]);
    expect(row.rows[0]).toEqual({ email: "victim2@kobe-victim.test", email_verified: false });
    expect((await browser.get("/v1/me/invites")).json.invitations).toEqual([]);
    expect((await browser.post(`/v1/me/invites/${teamId}/accept`)).status).toBe(404);
    expect((await browser.post(`/v1/me/invites/${teamId}/decline`)).status).toBe(404);
    const member = await h.admin.query(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId],
    );
    expect(member.rows).toEqual([{ role: "contributor" }]);
    // The invitation is still there for the real owner of the address.
    const open = await h.admin.query(
      `SELECT 1 FROM team_invitations WHERE email = 'victim2@kobe-victim.test'`,
    );
    expect(open.rowCount).toBe(1);
  });

  it("generic: a verified email (email_verified: true) accepts its invitation", async () => {
    await invite("verified3@kobe-victim.test", "member");
    const { browser } = await signInVia(kc, "kc", {
      sub: "kc-verified-3",
      email: "verified3@kobe-victim.test",
      email_verified: true,
      groups: ["g-research"],
    });
    const list = await browser.get("/v1/me/invites");
    expect(list.json.invitations).toHaveLength(1);
    expect((await browser.post(`/v1/me/invites/${teamId}/accept`)).status).toBe(200);
  });
});

describe("SSO-made users get no local credential (SSO9, review finding 3)", () => {
  it("refuses passkey registration, a password change and TOTP enrolment", async () => {
    const { browser } = await signInVia(entra, "corp", entraUser());
    expect((await browser.get("/v1/me")).status).toBe(200);
    const authenticator = new SoftwareAuthenticator("kobe.test", "http://kobe.test");
    const options = await browser.get("/api/auth/passkey/generate-register-options");
    expect(options.status).toBe(403);
    expect(options.json.code).toBe("SSO_ONLY_ACCOUNT");
    const verify = await browser.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register({
        challenge: "AAAA",
        rp: { id: "kobe.test", name: "Kobe" },
        user: { id: "AAAA", name: "x" },
      }),
    });
    expect(verify.status).toBe(403);
    const change = await browser.post("/api/auth/change-password", {
      currentPassword: "x",
      newPassword: "a-new-long-password-123",
    });
    expect(change.status).toBe(403);
    const totp = await browser.post("/api/auth/two-factor/enable", { password: "x" });
    expect(totp.status).toBe(403);
    const userId = (await browser.get("/v1/me")).json.user.id as string;
    const creds = await h.admin.query(
      `SELECT (SELECT count(*)::int FROM passkeys WHERE user_id = $1) AS passkeys,
              (SELECT count(*)::int FROM accounts WHERE user_id = $1) AS accounts`,
      [userId],
    );
    expect(creds.rows[0]).toEqual({ passkeys: 0, accounts: 0 });
  });

  it("still lets a local user add a passkey", async () => {
    await h.createUser("pk-local@sso-signin.test");
    const b = await h.signIn("pk-local@sso-signin.test");
    const options = await b.get("/api/auth/passkey/generate-register-options");
    expect(options.status, options.text).toBe(200);
  });
});

describe("state, nonce and ID token checks (ac-1)", () => {
  it("refuses a tampered state parameter", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const cb = new URL(flow.callback);
    cb.searchParams.set("state", `${cb.searchParams.get("state")}x`);
    expect(errorOf((await finish(flow, cb)).location)).toBe("state_invalid");
  });

  it("refuses a tampered flow cookie", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const raw = Buffer.from(flow.flowCookie, "base64url");
    raw[raw.length - 2] = (raw[raw.length - 2] ?? 0) ^ 1;
    flow.browser.cookies.set("kobe-sso", raw.toString("base64url"));
    expect(errorOf((await finish(flow)).location)).toBe("state_invalid");
  });

  it("refuses a callback in a browser that did not start the flow (login CSRF)", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const other = h.browser();
    const res = await other.get(`${flow.callback.pathname}${flow.callback.search}`);
    expect(errorOf(res.headers.get("location") ?? "")).toBe("state_invalid");
  });

  it("refuses a replayed callback with its cookie (single use)", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    expect(errorOf((await finish(flow)).location)).toBeNull();
    const replay = h.browser();
    replay.cookies.set("kobe-sso", flow.flowCookie);
    const res = await replay.get(`${flow.callback.pathname}${flow.callback.search}`);
    expect(errorOf(res.headers.get("location") ?? "")).toBe("state_invalid");
    expect((await replay.get("/v1/me")).status).toBe(401);
  });

  it("refuses a flow cookie used on another provider's callback", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const res = await flow.browser.get(`/api/auth/sso/callback/kc${flow.callback.search}`);
    expect(errorOf(res.headers.get("location") ?? "")).toBe("state_invalid");
  });

  it.each([
    ["a wrong nonce", { nonce: "not-the-nonce" }, ["token_invalid"]],
    ["a wrong audience", { aud: "someone-else" }, ["token_invalid"]],
    [
      "a wrong issuer",
      { iss: "https://login.microsoftonline.com/common/v2.0" },
      ["token_invalid", "tenant_mismatch"],
    ],
    ["a wrong tenant", { tid: "99999999-2222-4333-8444-555555555555" }, ["tenant_mismatch"]],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }, ["token_invalid"]],
    ["a stale auth_time", { auth_time: Math.floor(Date.now() / 1000) - 3600 }, ["token_invalid"]],
  ])("refuses %s", async (_what, overrides, codes) => {
    const before = await userCount();
    entra.overrides = overrides;
    try {
      const { location, browser } = await signInVia(entra, "corp", entraUser());
      expect(codes).toContain(errorOf(location));
      expect((await browser.get("/v1/me")).status).toBe(401);
    } finally {
      entra.overrides = {};
    }
    expect(await userCount()).toBe(before);
  });

  it.each(["alg_none", "hs256_client_secret", "foreign_key"] as const)(
    "refuses an ID token in mode %s (even though discovery lists none/HS256)",
    async (mode) => {
      const before = await userCount();
      entra.mode = mode;
      try {
        const { location, browser } = await signInVia(entra, "corp", entraUser());
        expect(errorOf(location)).toBe("token_invalid");
        expect((await browser.get("/v1/me")).status).toBe(401);
      } finally {
        entra.mode = "ok";
      }
      expect(await userCount()).toBe(before);
    },
  );

  it("refuses a wrong RFC 9207 iss parameter", async () => {
    entra.issParameter = "https://evil.example.com";
    try {
      const { location } = await signInVia(entra, "corp", entraUser());
      expect(errorOf(location)).toBe("token_invalid");
    } finally {
      entra.issParameter = undefined;
    }
  });

  it("reports an IdP error answer (e.g. cancelled) without a session", async () => {
    const flow = await startAt(entra, "corp", entraUser());
    const res = await flow.browser.get(
      (() => {
        const u = entra.deny(flow.startLocation);
        return `${u.pathname}${u.search}`;
      })(),
    );
    expect(errorOf(res.headers.get("location") ?? "")).toBe("idp_error");
  });
});

describe("returnTo (open redirect)", () => {
  it.each([
    "//evil.example.com",
    "https://evil.example.com/x",
    "/\\evil.example.com",
    "/%2F%2Fevil",
  ])("lands %s on /", async (returnTo) => {
    const { location } = await signInVia(entra, "corp", entraUser(), returnTo);
    expect(location).toBe("http://kobe.test/");
  });
});

describe("groups overage (generic provider, access claim groups)", () => {
  it("creates a user from the groups claim (ES256 token)", async () => {
    const { location } = await signInVia(kc, "kc", {
      sub: "kc-user-1",
      email: "kc1@example.com",
      email_verified: true,
      groups: ["g-research"],
    });
    expect(errorOf(location)).toBeNull();
  });

  it("refuses an overage for an unlinked identity", async () => {
    const { location } = await signInVia(kc, "kc", {
      sub: "kc-user-2",
      email: "kc2@example.com",
      _claim_names: { groups: "src1" },
      _claim_sources: { src1: { endpoint: "https://graph.example.com" } },
    });
    expect(errorOf(location)).toBe("groups_overage");
  });

  it("refuses an overage for a linked user without SCIM, uses SCIM memberships with it", async () => {
    const user = { sub: "kc-user-3", email: "kc3@example.com", groups: ["g-research"] };
    const first = await signInVia(kc, "kc", user);
    const userId = (await first.browser.get("/v1/me")).json.user.id as string;
    const overage = { ...user, groups: undefined, hasgroups: true };
    expect(errorOf((await signInVia(kc, "kc", overage)).location)).toBe("groups_overage");
    await h.admin.query(
      `INSERT INTO scim_tokens (provider_id, token_hash, prefix) VALUES ($1, $2, 'kobe_scim_x')`,
      [kcId, "a".repeat(64)],
    );
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO scim_groups (provider_id, external_id, display_name)
       VALUES ($1, 'g-research', 'Research') RETURNING id`,
      [kcId],
    );
    await h.admin.query(`INSERT INTO scim_group_members (group_id, user_id) VALUES ($1, $2)`, [
      rows[0]?.id,
      userId,
    ]);
    const ok = await signInVia(kc, "kc", overage);
    expect(errorOf(ok.location)).toBeNull();
    expect((await ok.browser.get("/v1/me")).json.user.id).toBe(userId);
  });
});

describe("site requires 2FA (MFA trust is SSO-4)", () => {
  it("refuses SSO with mfa_missing rather than letting the session enrol TOTP", async () => {
    await h.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('require_2fa', 'true')
       ON CONFLICT (key) DO UPDATE SET value = 'true'`,
    );
    try {
      const { location } = await signInVia(entra, "corp", entraUser());
      expect(errorOf(location)).toBe("mfa_missing");
    } finally {
      await h.admin.query(`DELETE FROM site_settings WHERE key = 'require_2fa'`);
    }
  });
});

describe("break-glass (SSO10): local sign-in never contacts the IdP", () => {
  it("signs the setup Owner in with a password and a passkey while the IdP is down", async () => {
    const authenticator = new SoftwareAuthenticator("kobe.test", "http://kobe.test");
    const ownerB = await h.signIn("owner@sso-signin.test");
    const options = await ownerB.get("/api/auth/passkey/generate-register-options");
    const registered = await ownerB.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register(options.json),
      name: "break-glass key",
    });
    expect(registered.status, registered.text).toBe(200);
    await h.createUser("local@sso-signin.test");

    entra.down = true;
    kc.down = true;
    const hits = entra.hits.length + kc.hits.length;
    try {
      const pw = h.browser();
      const res = await pw.post("/api/auth/sign-in/email", {
        email: "owner@sso-signin.test",
        password: PASSWORD,
      });
      expect(res.status, res.text).toBe(200);
      expect((await pw.get("/v1/me")).json.user.id).toBe(ownerId);

      const pk = h.browser();
      const authOptions = await pk.get("/api/auth/passkey/generate-authenticate-options");
      const verified = await pk.post("/api/auth/passkey/verify-authentication", {
        response: authenticator.authenticate(authOptions.json),
      });
      expect(verified.status, verified.text).toBe(200);
      expect((await pk.get("/v1/me")).json.user.id).toBe(ownerId);

      const local = await h.signIn("local@sso-signin.test");
      expect((await local.get("/v1/me")).status).toBe(200);
      expect(entra.hits.length + kc.hits.length).toBe(hits);

      // SSO itself reports the outage plainly (discovery is cached; the token endpoint is not).
      const flow = await startAt(entra, "corp", entraUser());
      expect(errorOf((await finish(flow)).location)).toBe("idp_unreachable");
    } finally {
      entra.down = false;
      kc.down = false;
    }
  });
});

describe("rate limits", () => {
  it("allows 20 starts per minute per address", async () => {
    const b = h.browser();
    for (let i = 0; i < 20; i++) {
      expect((await b.get("/api/auth/sso/start/corp")).status).toBe(302);
    }
    expect((await b.get("/api/auth/sso/start/corp")).status).toBe(429);
  });
});

describe("kill switch (auth.sso.enabled: false)", () => {
  it("answers 404 on every SSO route", async () => {
    const off = await openHarness({
      sso: {
        settings: settingsFor("false"),
        net: { resolve: resolver() },
        request: routeMockOidc(entra, kc),
      },
    });
    try {
      await seedHelmProviders(off.deps.database.db, settingsFor("false"));
      const b = off.browser();
      expect((await b.get("/api/auth/sso/providers")).status).toBe(404);
      expect((await b.get("/api/auth/sso/start/corp")).status).toBe(404);
      expect((await b.get("/api/auth/sso/callback/corp?code=x&state=y")).status).toBe(404);
    } finally {
      await off.close();
    }
  });
});

describe("one browser code for no access and an existing account (review finding 9b)", () => {
  it("answers not_allowed for both and keeps the reason in the audit log", async () => {
    await h.createUser("exists-9b@contoso.com");
    const linked = await signInVia(
      entra,
      "corp",
      entraUser({ preferred_username: "exists-9b@contoso.com" }),
    );
    const none = await signInVia(entra, "corp", entraUser({ roles: ["nothing"] }));
    expect(errorOf(linked.location)).toBe("not_allowed");
    expect(errorOf(none.location)).toBe("not_allowed");
    expect(linked.location).toBe(none.location);
    expect((await failures("link_required")).length).toBeGreaterThan(0);
    expect((await failures("no_access")).length).toBeGreaterThan(0);
  });
});

describe("max_session_hours (review finding 9a)", () => {
  it("caps the SSO session's expiry and ends it once the hours have passed", async () => {
    await h.admin.query(`UPDATE sso_providers SET max_session_hours = 1 WHERE id = $1`, [corpId]);
    try {
      const user = entraUser();
      const { browser } = await signInVia(entra, "corp", user);
      // Read before any request: Better Auth's refresh may push expires_at forward on use.
      const { rows } = await h.admin.query<{ id: string; left: number }>(
        `SELECT s.id, extract(epoch FROM s.expires_at - now())::int AS left
           FROM sessions s JOIN sso_identities i ON i.user_id = s.user_id
          WHERE i.subject = $1`,
        [user.oid],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.left).toBeLessThanOrEqual(3600);
      expect((await browser.get("/v1/me")).status).toBe(200);
      // The cap counts from the session's start, whatever a refresh did to expires_at.
      await h.admin.query(
        `UPDATE sessions SET created_at = now() - interval '61 minutes',
                             expires_at = now() + interval '1 day' WHERE id = $1`,
        [rows[0]?.id],
      );
      expect((await browser.get("/v1/me")).status).toBe(401);
      const gone = await h.admin.query(`SELECT 1 FROM sessions WHERE id = $1`, [rows[0]?.id]);
      expect(gone.rowCount).toBe(0);
    } finally {
      await h.admin.query(`UPDATE sso_providers SET max_session_hours = NULL WHERE id = $1`, [
        corpId,
      ]);
    }
  });
});

describe("max_session_hours against Better Auth's refresh (re-review A)", () => {
  it("never lets a refresh push an SSO session past created_at + max hours", async () => {
    await h.admin.query(`UPDATE sso_providers SET max_session_hours = 1 WHERE id = $1`, [corpId]);
    try {
      const user = entraUser();
      const { browser } = await signInVia(entra, "corp", user);
      // A capped session is "due" for Better Auth's refresh at once: get-session refreshes it.
      const got = await browser.get("/api/auth/get-session");
      expect(got.status, got.text).toBe(200);
      const over = await h.admin.query<{ over: boolean }>(
        `SELECT s.expires_at > s.created_at + interval '1 hour' AS over
           FROM sessions s JOIN sso_identities i ON i.user_id = s.user_id WHERE i.subject = $1`,
        [user.oid],
      );
      expect(over.rows).toEqual([{ over: false }]);
      // Any later update of the expiry is capped as well.
      await h.admin.query(
        `UPDATE sessions s SET expires_at = now() + interval '30 days'
           FROM sso_identities i WHERE i.user_id = s.user_id AND i.subject = $1`,
        [user.oid],
      );
      const again = await h.admin.query<{ over: boolean }>(
        `SELECT s.expires_at > s.created_at + interval '1 hour' AS over
           FROM sessions s JOIN sso_identities i ON i.user_id = s.user_id WHERE i.subject = $1`,
        [user.oid],
      );
      expect(again.rows).toEqual([{ over: false }]);
    } finally {
      await h.admin.query(`UPDATE sso_providers SET max_session_hours = NULL WHERE id = $1`, [
        corpId,
      ]);
    }
  });
});

describe("kill switch and live sessions (review finding 6)", () => {
  it("refuses SSO sessions while auth.sso.enabled is false; local sessions keep working", async () => {
    const { browser } = await signInVia(entra, "corp", entraUser());
    expect((await browser.get("/v1/me")).status).toBe(200);
    const local = await h.signIn("owner@sso-signin.test");
    const offSettings = settingsFor("false");
    const offApp = createApp({ ...h.deps, sso: { ...h.deps.sso, settings: offSettings } });
    const as = (from: TestBrowser) => {
      const b = new TestBrowser(offApp, PUBLIC_URL);
      for (const [k, v] of from.cookies) b.cookies.set(k, v);
      return b;
    };
    expect((await as(browser).get("/v1/me")).status).toBe(401);
    expect((await as(local).get("/v1/me")).status).toBe(200);

    // At start-up with the switch off, every SSO session is deleted; local ones stay.
    const ended = await endSsoSessionsWhenOff(h.deps.database.db, offSettings);
    expect(ended).toBeGreaterThan(0);
    const left = await h.admin.query(`SELECT 1 FROM session_sso_contexts`);
    expect(left.rowCount).toBe(0);
    expect((await browser.get("/v1/me")).status).toBe(401);
    expect((await local.get("/v1/me")).status).toBe(200);
    expect(await endSsoSessionsWhenOff(h.deps.database.db, settingsFor("true"))).toBe(0);
  });
});
