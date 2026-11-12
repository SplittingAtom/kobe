import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessions, sessionSsoContexts, ssoIdentities, ssoProviders } from "@kobe/db";
import { createApp } from "./app.js";
import { loadSsoSettings } from "./sso/settings.js";
import { TestBrowser } from "./testing/browser.js";
import { openHarness, PASSWORD, PUBLIC_URL, type Harness } from "./testing/harness.js";

/**
 * SCIM 2.0 Users and tokens (KOBE-631, spec sso-oidc-scim §10, SSO5/SSO8/SSO9/SSO10): tokens from
 * the Site console (hashed, shown once, rotate, revoke), the `/v1/scim/v2/<slug>` endpoints with
 * Microsoft Entra's request sequence and quirks, deactivation through the console's path, the
 * site-role guard, the kill switch, and the per-provider token boundary.
 */
const SCIM = "/v1/scim/v2";
const SCIM_TYPE = "application/scim+json";
const TENANT_A = "11111111-2222-4333-8444-555555555555";
const TENANT_B = "99999999-2222-4333-8444-555555555555";
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

let h: Harness;
let owner: TestBrowser;
let member: TestBrowser;
let ownerId = "";
let adminId = "";
let localId = "";
const providers: Record<string, string> = {};
const tokens: Record<string, string> = {};

interface ScimRes {
  status: number;
  json: any;
  headers: Headers;
}

async function scim(
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ScimRes> {
  const res = await h.app.request(`${PUBLIC_URL}${SCIM}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": SCIM_TYPE } : {}),
      "x-forwarded-for": "203.0.113.9",
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

async function addProvider(slug: string, tenantId: string, enabled = true): Promise<string> {
  const [row] = await h.deps.database.db
    .insert(ssoProviders)
    .values({
      slug,
      displayName: slug,
      kind: "entra",
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      tenantId,
      clientId: `${slug}-app`,
      clientSecretSealed: "e1.test-only-not-a-real-envelope",
      clientSecretKeyId: "k1",
      subjectClaim: "oid",
      accessClaim: "roles",
      enabled,
    })
    .returning({ id: ssoProviders.id });
  if (!row) throw new Error("provider insert returned no row");
  return row.id;
}

async function newToken(slug: string): Promise<{ token: string; id: string }> {
  const res = await owner.post(`/v1/site/sso/providers/${providers[slug]}/scim/tokens`);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { token: res.json.token, id: res.json.credential.id };
}

async function auditRows(action: string): Promise<any[]> {
  const r = await h.admin.query(
    "SELECT actor_kind, actor_id, target FROM audit_log WHERE action = $1 ORDER BY seq",
    [action],
  );
  return r.rows;
}

/** A sign-in session for `userId`; with `providerId`, one made through that provider's SSO. */
async function sessionFor(userId: string, providerId?: string): Promise<string> {
  const [s] = await h.deps.database.db
    .insert(sessions)
    .values({
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: sessions.id });
  if (!s) throw new Error("session insert returned no row");
  if (providerId) {
    await h.deps.database.db
      .insert(sessionSsoContexts)
      .values({ sessionId: s.id, providerId, mfaSatisfied: true });
  }
  return s.id;
}

async function sessionExists(id: string): Promise<boolean> {
  const r = await h.admin.query("SELECT 1 FROM sessions WHERE id = $1", [id]);
  return r.rowCount === 1;
}

const validatorUser = (suffix: string, objectId = randomUUID()) => ({
  schemas: [
    "urn:ietf:params:scim:schemas:core:2.0:User",
    "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
  ],
  externalId: objectId,
  userName: `Test_User_${suffix}`,
  active: true,
  emails: [{ primary: true, type: "work", value: `Test_User_${suffix}@testuser.com` }],
  meta: { resourceType: "User" },
  name: { formatted: "givenName familyName", familyName: "familyName", givenName: "givenName" },
  roles: [],
});

beforeAll(async () => {
  h = await openHarness({ sso: { settings: loadSsoSettings({ KOBE_SSO_ENABLED: "true" }) } });
  ownerId = await h.createUser("owner@scim.test", "owner");
  adminId = await h.createUser("admin@scim.test", "admin");
  localId = await h.createUser("local@scim.test");
  owner = await h.signIn("owner@scim.test");
  member = await h.signIn("local@scim.test");
  providers.contoso = await addProvider("contoso", TENANT_A);
  providers.fabrikam = await addProvider("fabrikam", TENANT_B);
  providers.dormant = await addProvider("dormant", TENANT_B, false);
  tokens.contoso = (await newToken("contoso")).token;
  tokens.fabrikam = (await newToken("fabrikam")).token;
  tokens.dormant = (await newToken("dormant")).token;
});
afterAll(async () => {
  await h?.close();
});

describe("SCIM tokens in the Site console", () => {
  it("shows a token once, stores only its hash, and audits the credential id", async () => {
    const res = await owner.post(`/v1/site/sso/providers/${providers.fabrikam}/scim/tokens`);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const token: string = res.json.token;
    expect(token).toMatch(/^kobe_scim_[A-Za-z0-9_-]{43}$/);
    expect(res.json.baseUrl).toBe(`${PUBLIC_URL}/v1/scim/v2/fabrikam`);
    const list = await owner.get(`/v1/site/sso/providers/${providers.fabrikam}/scim`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain(token.slice(14));
    expect(list.json.tokens[0]).toEqual({
      id: res.json.credential.id,
      prefix: token.slice(0, 14),
      createdAt: expect.any(String),
      lastUsedAt: null,
      revokedAt: null,
    });
    const stored = await h.admin.query("SELECT token_hash FROM scim_tokens WHERE id = $1", [
      res.json.credential.id,
    ]);
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].token_hash).not.toContain(token);
    const audits = await auditRows("identity.scim.token.created");
    expect(audits.at(-1).target).toEqual({
      providerId: providers.fabrikam,
      credentialId: res.json.credential.id,
    });
    const all = await h.admin.query("SELECT target::text AS t FROM audit_log");
    expect(all.rows.some((r) => r.t.includes(token.slice(10)))).toBe(false);
    // Two live now: a third is refused until one is revoked.
    const third = await owner.post(`/v1/site/sso/providers/${providers.fabrikam}/scim/tokens`);
    expect(third.status).toBe(409);
    expect(third.json.code).toBe("too_many_tokens");
    const revoked = await owner.post(
      `/v1/site/sso/providers/${providers.fabrikam}/scim/tokens/${res.json.credential.id}/revoke`,
    );
    expect(revoked.status).toBe(200);
  });

  it("rotates: the old token works until it is revoked, then gets 401 (ac-3)", async () => {
    const first = await newToken("contoso");
    expect((await scim("GET", "/contoso/Users", first.token)).status).toBe(200);
    const rotated = await owner.post(
      `/v1/site/sso/providers/${providers.contoso}/scim/tokens/${first.id}/rotate`,
    );
    // contoso already had one live token from beforeAll: rotation can't make a third.
    expect(rotated.status).toBe(409);
    const list = await owner.get(`/v1/site/sso/providers/${providers.contoso}/scim`);
    const original = list.json.tokens.find((t: any) => t.id !== first.id && !t.revokedAt);
    await owner.post(
      `/v1/site/sso/providers/${providers.contoso}/scim/tokens/${original.id}/revoke`,
    );
    expect((await scim("GET", "/contoso/Users", tokens.contoso)).status).toBe(401);
    const again = await owner.post(
      `/v1/site/sso/providers/${providers.contoso}/scim/tokens/${first.id}/rotate`,
    );
    expect(again.status).toBe(201);
    expect(again.json.replaces).toBe(first.id);
    // Both work during the rotation.
    expect((await scim("GET", "/contoso/Users", first.token)).status).toBe(200);
    expect((await scim("GET", "/contoso/Users", again.json.token)).status).toBe(200);
    const done = await owner.post(
      `/v1/site/sso/providers/${providers.contoso}/scim/tokens/${first.id}/revoke`,
    );
    expect(done.json.credential.revokedAt).toEqual(expect.any(String));
    const revoked = await scim("GET", "/contoso/Users", first.token);
    expect(revoked.status).toBe(401);
    expect(revoked.json.schemas).toEqual([ERROR]);
    expect(revoked.headers.get("www-authenticate")).toContain("Bearer");
    const twice = await owner.post(
      `/v1/site/sso/providers/${providers.contoso}/scim/tokens/${first.id}/revoke`,
    );
    expect(twice.status).toBe(409);
    tokens.contoso = again.json.token;
    const used = await owner.get(`/v1/site/sso/providers/${providers.contoso}/scim`);
    expect(used.json.tokens.find((t: any) => t.id === again.json.credential.id).lastUsedAt).toEqual(
      expect.any(String),
    );
    expect((await auditRows("identity.scim.token.revoked")).length).toBeGreaterThanOrEqual(2);
  });

  it("is for site.users.manage only", async () => {
    const path = `/v1/site/sso/providers/${providers.contoso}/scim`;
    expect((await member.get(path)).status).toBe(403);
    expect((await member.post(`${path}/tokens`)).status).toBe(403);
  });
});

describe("authentication and the provider boundary", () => {
  it("accepts only the provider's own bearer token (ac-4)", async () => {
    expect((await scim("GET", "/contoso/Users", undefined)).status).toBe(401);
    expect((await scim("GET", "/contoso/Users", "kobe_scim_nope")).status).toBe(401);
    // A token of provider B on provider A's URL.
    const cross = await scim("GET", "/contoso/Users", tokens.fabrikam);
    expect(cross.status).toBe(401);
    const crossCreate = await scim("POST", "/contoso/Users", tokens.fabrikam, validatorUser("x"));
    expect(crossCreate.status).toBe(401);
    // An unknown slug looks the same as a wrong token.
    expect((await scim("GET", "/nobody/Users", tokens.contoso)).status).toBe(401);
  });

  it("never authenticates with a session cookie", async () => {
    const cookie = [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await scim("GET", "/contoso/Users", undefined, undefined, {
      cookie,
      origin: PUBLIC_URL,
    });
    expect(res.status).toBe(401);
  });

  it("refuses a turned-off provider's token with 403", async () => {
    const res = await scim("GET", "/dormant/Users", tokens.dormant);
    expect(res.status).toBe(403);
    expect(res.json.detail).toMatch(/turned off/);
  });

  it("answers 404 for everything when auth.sso.enabled is false", async () => {
    const off = { ...h.deps.sso, settings: { ...h.deps.sso.settings, enabled: false } };
    const app = createApp({ ...h.deps, sso: off });
    for (const path of ["/contoso/Users", "/contoso/ServiceProviderConfig"]) {
      const res = await app.request(`${PUBLIC_URL}${SCIM}${path}`, {
        headers: { authorization: `Bearer ${tokens.contoso}` },
      });
      expect(res.status).toBe(404);
    }
    const b = new TestBrowser(app, PUBLIC_URL);
    for (const [k, v] of owner.cookies) b.cookies.set(k, v);
    const tokensRoute = await b.get(`/v1/site/sso/providers/${providers.contoso}/scim`);
    expect(tokensRoute.status).toBe(404);
  });

  it("rate limits each token at 600 requests a minute", async () => {
    const t = await newToken("fabrikam");
    await h.admin.query("INSERT INTO rate_limits (key, count, last_request) VALUES ($1, 600, $2)", [
      `kobe:scim:${t.id}`,
      Date.now(),
    ]);
    const res = await scim("GET", "/fabrikam/Users", t.token);
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain(SCIM_TYPE);
    expect(res.json.schemas).toEqual([ERROR]);
    // Other tokens keep their own budget.
    expect((await scim("GET", "/fabrikam/Users", tokens.fabrikam)).status).toBe(200);
  });
});

describe("discovery endpoints", () => {
  it("serve ServiceProviderConfig, ResourceTypes and Schemas as scim+json", async () => {
    const spc = await scim("GET", "/contoso/ServiceProviderConfig", tokens.contoso);
    expect(spc.status).toBe(200);
    expect(spc.headers.get("content-type")).toContain(SCIM_TYPE);
    expect(spc.json).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 200 },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken" }],
    });
    const types = await scim("GET", "/contoso/ResourceTypes", tokens.contoso);
    expect(types.json.Resources.map((r: any) => r.id)).toEqual(["User"]);
    const schemas = await scim("GET", "/contoso/Schemas", tokens.contoso);
    expect(schemas.json.Resources[0].id).toBe("urn:ietf:params:scim:schemas:core:2.0:User");
    // No Groups until SSO-8.
    expect((await scim("GET", "/contoso/Groups", tokens.contoso)).status).toBe(404);
  });
});

describe("Microsoft Entra's SCIM request sequence for Users (ac-1, ac-2)", () => {
  it("passes create → get by filter → PATCH attributes → active=false → GET → active=true → DELETE", async () => {
    const t = tokens.contoso;
    const suffix = randomUUID();
    const objectId = randomUUID();

    // Entra's probe: a random userName answers an empty list.
    const probe = await scim(
      "GET",
      `/contoso/Users?filter=${encodeURIComponent(`userName eq "${randomUUID()}"`)}`,
      t,
    );
    expect(probe.status).toBe(200);
    expect(probe.json).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 0,
      Resources: [],
    });

    // Create (validator-style body).
    const created = await scim("POST", "/contoso/Users", t, validatorUser(suffix, objectId));
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.headers.get("content-type")).toContain(SCIM_TYPE);
    const id: string = created.json.id;
    expect(created.headers.get("location")).toBe(`${PUBLIC_URL}${SCIM}/contoso/Users/${id}`);
    expect(created.json).toMatchObject({
      externalId: objectId,
      userName: `Test_User_${suffix}`,
      active: true,
      displayName: "givenName familyName",
      emails: [{ value: `test_user_${suffix}@testuser.com`, type: "work", primary: true }],
    });
    // SSO9: no local credential; linked by externalId (objectId).
    const accounts = await h.admin.query("SELECT 1 FROM accounts WHERE user_id = $1", [id]);
    expect(accounts.rowCount).toBe(0);
    const link = await h.admin.query(
      "SELECT subject, linked_via FROM sso_identities WHERE user_id = $1",
      [id],
    );
    expect(link.rows).toEqual([{ subject: objectId, linked_via: "scim" }]);
    const createdAudit = (await auditRows("identity.scim.user.created")).at(-1);
    expect(createdAudit.actor_kind).toBe("system");
    expect(createdAudit.target).toMatchObject({ providerId: providers.contoso, userId: id });
    expect(createdAudit.target.credentialId).toEqual(expect.any(String));

    // A second create of the same user is a uniqueness conflict.
    const dup = await scim("POST", "/contoso/Users", t, validatorUser(suffix, objectId));
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ schemas: [ERROR], status: "409", scimType: "uniqueness" });

    // Get by filter (userName, any case) and by externalId, then by id.
    const byName = await scim(
      "GET",
      `/contoso/Users?filter=${encodeURIComponent(`userName eq "test_user_${suffix}"`)}`,
      t,
    );
    expect(byName.json.totalResults).toBe(1);
    expect(byName.json.Resources[0].id).toBe(id);
    const byExternal = await scim(
      "GET",
      `/contoso/Users?filter=${encodeURIComponent(`externalId eq "${objectId}"`)}&startIndex=1&count=10`,
      t,
    );
    expect(byExternal.json).toMatchObject({ totalResults: 1, startIndex: 1, itemsPerPage: 1 });
    expect((await scim("GET", `/contoso/Users/${id}`, t)).json.id).toBe(id);

    // PATCH multi-valued (emails[type eq "work"].value) and name.familyName.
    const multi = await scim("PATCH", `/contoso/Users/${id}`, t, {
      schemas: [PATCH_OP],
      Operations: [
        {
          op: "Replace",
          path: 'emails[type eq "work"].value',
          value: `updated_${suffix}@contoso.com`,
        },
        { op: "Replace", path: "name.familyName", value: "updatedFamilyName" },
      ],
    });
    expect(multi.status, JSON.stringify(multi.json)).toBe(200);
    expect(multi.json.emails[0].value).toBe(`updated_${suffix}@contoso.com`);
    // One name part alone keeps the name (Kobe keeps a single name).
    expect(multi.json.displayName).toBe("givenName familyName");

    // PATCH single-valued: userName (now the UPN), and a path-less value object.
    const upn = `ann.${suffix}@contoso.com`;
    const single = await scim("PATCH", `/contoso/Users/${id}`, t, {
      schemas: [PATCH_OP],
      Operations: [
        { op: "Replace", path: "userName", value: upn },
        { op: "replace", value: { displayName: "Ann Lee", "name.givenName": "Ann", title: "Eng" } },
      ],
    });
    expect(single.status).toBe(200);
    expect(single.json).toMatchObject({ userName: upn, displayName: "Ann Lee" });
    expect(single.json.emails[0].value).toBe(upn);
    expect((await auditRows("identity.scim.user.updated")).length).toBeGreaterThanOrEqual(2);

    // active=false (as Entra sends it: path-less, "False") ends the sessions in the same request.
    const live = await sessionFor(id);
    const off = await scim("PATCH", `/contoso/Users/${id}`, t, {
      schemas: [PATCH_OP],
      Operations: [{ op: "Replace", value: { active: "False" } }],
    });
    expect(off.status).toBe(200);
    expect(off.json.active).toBe(false);
    expect(await sessionExists(live)).toBe(false);
    const deact = await h.admin.query("SELECT deactivated_at FROM users WHERE id = $1", [id]);
    expect(deact.rows[0].deactivated_at).not.toBeNull();
    expect((await auditRows("identity.user.deactivated")).at(-1)).toMatchObject({
      actor_kind: "system",
      target: { userId: id },
    });
    expect((await auditRows("identity.scim.user.deactivated")).at(-1).target).toMatchObject({
      userId: id,
    });

    // GET shows it inactive; a session can't be created for it meanwhile.
    expect((await scim("GET", `/contoso/Users/${id}`, t)).json.active).toBe(false);

    // active=true reactivates.
    const on = await scim("PATCH", `/contoso/Users/${id}`, t, {
      schemas: [PATCH_OP],
      Operations: [{ op: "Replace", path: "active", value: "True" }],
    });
    expect(on.json.active).toBe(true);
    expect((await auditRows("identity.scim.user.reactivated")).at(-1).target.userId).toBe(id);

    // DELETE deactivates and unlinks; the user row stays (Kobe never deletes users).
    const del = await scim("DELETE", `/contoso/Users/${id}`, t);
    expect(del.status).toBe(204);
    expect((await scim("GET", `/contoso/Users/${id}`, t)).status).toBe(404);
    const after = await h.admin.query("SELECT deactivated_at FROM users WHERE id = $1", [id]);
    expect(after.rows[0].deactivated_at).not.toBeNull();
    expect(
      (await h.admin.query("SELECT 1 FROM sso_identities WHERE user_id = $1", [id])).rowCount,
    ).toBe(0);
    expect((await auditRows("identity.sso.link.removed")).at(-1).target).toMatchObject({
      userId: id,
      by: "scim",
    });
  });

  it("PUT replaces the resource; a provider sees only its own users", async () => {
    const t = tokens.contoso;
    const created = await scim("POST", "/contoso/Users", t, {
      userName: `bob.${randomUUID()}@contoso.com`,
      externalId: randomUUID(),
      displayName: "Bob",
    });
    expect(created.status).toBe(201);
    const put = await scim("PUT", `/contoso/Users/${created.json.id}`, t, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: created.json.userName,
      externalId: created.json.externalId,
      displayName: "Robert",
      active: true,
    });
    expect(put.status).toBe(200);
    expect(put.json.displayName).toBe("Robert");
    // fabrikam's token sees none of contoso's users.
    const other = await scim("GET", `/fabrikam/Users/${created.json.id}`, tokens.fabrikam);
    expect(other.status).toBe(404);
    const list = await scim("GET", "/fabrikam/Users", tokens.fabrikam);
    expect(list.json.totalResults).toBe(0);
    // A create with active "False" makes a deactivated user; a PUT without active keeps it so.
    const inactive = await scim("POST", "/contoso/Users", t, {
      userName: `eve.${randomUUID()}@contoso.com`,
      externalId: randomUUID(),
      active: "False",
    });
    expect(inactive.json.active).toBe(false);
    const kept = await scim("PUT", `/contoso/Users/${inactive.json.id}`, t, {
      userName: inactive.json.userName,
      externalId: inactive.json.externalId,
      displayName: "Eve",
    });
    expect(kept.json).toMatchObject({ active: false, displayName: "Eve" });
  });
});

describe("the site-role guard (SSO8, SSO10; ac-5)", () => {
  async function link(userId: string, subject = randomUUID()) {
    await h.deps.database.db.insert(ssoIdentities).values({
      providerId: providers.contoso ?? "",
      subject,
      userId,
      linkedVia: "jit",
    });
  }

  it("never deactivates the Owner or a site Admin; their SSO sessions end, local ones stay", async () => {
    await link(ownerId);
    await link(adminId);
    for (const userId of [ownerId, adminId]) {
      const sso = await sessionFor(userId, providers.contoso);
      const local = await sessionFor(userId);
      const res = await scim("PATCH", `/contoso/Users/${userId}`, tokens.contoso, {
        schemas: [PATCH_OP],
        Operations: [
          { op: "Replace", path: "active", value: "False" },
          { op: "Replace", path: "displayName", value: "Renamed" },
        ],
      });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({ schemas: [ERROR], status: "403" });
      expect(res.json.detail).toMatch(/never deactivates the Owner, a site Admin/);
      const row = await h.admin.query("SELECT deactivated_at, name FROM users WHERE id = $1", [
        userId,
      ]);
      expect(row.rows[0].deactivated_at).toBeNull();
      expect(row.rows[0].name).not.toBe("Renamed");
      expect(await sessionExists(sso)).toBe(false);
      expect(await sessionExists(local)).toBe(true);
      expect((await auditRows("identity.scim.deactivation_refused")).at(-1).target).toMatchObject({
        providerId: providers.contoso,
        userId,
      });
      const del = await scim("DELETE", `/contoso/Users/${userId}`, tokens.contoso);
      expect(del.status).toBe(403);
      expect(
        (await h.admin.query("SELECT 1 FROM sso_identities WHERE user_id = $1", [userId])).rowCount,
      ).toBe(1);
    }
    // The Owner still signs in locally.
    await h.signIn("owner@scim.test");
  });

  it("protects the setup Owner even without a site role", async () => {
    const setup = await h.deps.createUserWithPassword(
      { email: "setup@scim.test", name: "Setup", password: PASSWORD },
      { recordSetup: true },
    );
    await link(setup.id);
    const res = await scim("PATCH", `/contoso/Users/${setup.id}`, tokens.contoso, {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(res.status).toBe(403);
  });

  it("never re-addresses an account that has a local password", async () => {
    await link(localId);
    const res = await scim("PATCH", `/contoso/Users/${localId}`, tokens.contoso, {
      schemas: [PATCH_OP],
      Operations: [{ op: "Replace", path: "userName", value: "attacker@evil.example" }],
    });
    expect(res.status).toBe(200);
    expect(res.json.userName).toBe("attacker@evil.example");
    const row = await h.admin.query("SELECT email FROM users WHERE id = $1", [localId]);
    expect(row.rows[0].email).toBe("local@scim.test");
  });
});

describe("SCIM-created users and local credentials (SSO9; ac-6)", () => {
  it("can't sign in with a password, and a reset request sends nothing", async () => {
    const email = `carol.${randomUUID()}@contoso.com`;
    const created = await scim("POST", "/contoso/Users", tokens.contoso, {
      userName: email,
      externalId: randomUUID(),
      displayName: "Carol",
    });
    expect(created.status).toBe(201);
    const b = h.browser();
    const signIn = await b.post("/api/auth/sign-in/email", { email, password: PASSWORD });
    expect(signIn.status).not.toBe(200);
    const reset = await b.post("/api/auth/request-password-reset", { email });
    expect(reset.status).toBe(200);
    await h.mailer.settle();
    expect(h.mailer.to(email)).toEqual([]);
    const pending = await h.admin.query("SELECT 1 FROM verifications WHERE value = $1", [
      created.json.id,
    ]);
    expect(pending.rowCount).toBe(0);
    // A local user still gets their link.
    await b.post("/api/auth/request-password-reset", { email: "local@scim.test" });
    await h.mailer.settle();
    expect(h.mailer.to("local@scim.test").length).toBe(1);
  });

  it("never links on email: an existing local address is 409 uniqueness", async () => {
    const res = await scim("POST", "/contoso/Users", tokens.contoso, {
      userName: "admin@scim.test",
      externalId: randomUUID(),
    });
    expect(res.status).toBe(409);
    expect(res.json.scimType).toBe("uniqueness");
    expect(res.json.detail).toMatch(/expect an SSO link/);
  });
});

describe("SCIM errors and request limits", () => {
  it("answers RFC 7644 errors", async () => {
    const t = tokens.contoso;
    const bad = await scim("GET", `/contoso/Users?filter=${encodeURIComponent('name co "x"')}`, t);
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({
      schemas: [ERROR],
      status: "400",
      scimType: "invalidFilter",
      detail: expect.any(String),
    });
    const noUserName = await scim("POST", "/contoso/Users", t, { externalId: randomUUID() });
    expect(noUserName.json).toMatchObject({ status: "400", scimType: "invalidValue" });
    const noExternal = await scim("POST", "/contoso/Users", t, { userName: "x@contoso.com" });
    expect(noExternal.json).toMatchObject({ status: "400", scimType: "invalidValue" });
    const badOp = await scim("PATCH", `/contoso/Users/${randomUUID()}`, t, {
      Operations: [{ op: "explode" }],
    });
    expect(badOp.json).toMatchObject({ status: "400", scimType: "invalidSyntax" });
    expect((await scim("GET", `/contoso/Users/${randomUUID()}`, t)).status).toBe(404);
    expect((await scim("GET", "/contoso/Users/not-a-uuid", t)).status).toBe(404);
  });

  it("requires a JSON body type and bounds the body size", async () => {
    const t = tokens.contoso;
    const form = await scim("POST", "/contoso/Users", t, "userName=x", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(form.status).toBe(415);
    const huge = await scim("POST", "/contoso/Users", t, {
      userName: "x@contoso.com",
      padding: "x".repeat(70 * 1024),
    });
    expect(huge.status).toBe(413);
    expect(huge.json.schemas).toEqual([ERROR]);
    const plainJson = await scim(
      "POST",
      "/contoso/Users",
      t,
      { userName: `dan.${randomUUID()}@contoso.com`, externalId: randomUUID() },
      { "content-type": "application/json" },
    );
    expect(plainJson.status).toBe(201);
  });
});

describe("security review fixes (KOBE-sso-review1)", () => {
  const patch = (path: string, value: unknown) => ({
    schemas: [PATCH_OP],
    Operations: [{ op: "Replace", path, value }],
  });

  it("marks a SCIM address verified only for an Entra UPN in a verified domain (finding 1)", async () => {
    await h.admin.query(
      `UPDATE sso_providers SET allowed_email_domains = '{contoso.com}' WHERE id = $1`,
      [providers.contoso],
    );
    try {
      const make = async (body: Record<string, unknown>) => {
        const res = await scim("POST", "/contoso/Users", tokens.contoso, {
          externalId: randomUUID(),
          ...body,
        });
        expect(res.status, JSON.stringify(res.json)).toBe(201);
        const row = await h.admin.query("SELECT email, email_verified FROM users WHERE id = $1", [
          res.json.id,
        ]);
        return { id: res.json.id as string, ...row.rows[0] };
      };
      const upn = await make({ userName: `upn.${randomUUID()}@Contoso.com` });
      expect(upn.email_verified).toBe(true);
      const outside = await make({ userName: `x.${randomUUID()}@kobe-victim.test` });
      expect(outside.email_verified).toBe(false);
      const fromMail = await make({
        userName: `not-an-address-${randomUUID()}`,
        emails: [{ type: "work", value: `m.${randomUUID()}@contoso.com` }],
      });
      expect(fromMail.email_verified).toBe(false);
      // A re-address follows the same rule.
      const moved = await scim(
        "PATCH",
        `/contoso/Users/${upn.id}`,
        tokens.contoso,
        patch("userName", `moved.${randomUUID()}@kobe-victim.test`),
      );
      expect(moved.status).toBe(200);
      const after = await h.admin.query("SELECT email_verified FROM users WHERE id = $1", [upn.id]);
      expect(after.rows[0].email_verified).toBe(false);
    } finally {
      await h.admin.query(`UPDATE sso_providers SET allowed_email_domains = '{}' WHERE id = $1`, [
        providers.contoso,
      ]);
    }
  });

  it("keeps externalId immutable once set, even for a site Admin (finding 2)", async () => {
    const subject = randomUUID();
    await h.deps.database.db.insert(ssoIdentities).values({
      providerId: providers.fabrikam ?? "",
      subject,
      userId: adminId,
      linkedVia: "jit",
    });
    const sso = await sessionFor(adminId, providers.fabrikam);
    const res = await scim(
      "PATCH",
      `/fabrikam/Users/${adminId}`,
      tokens.fabrikam,
      patch("externalId", randomUUID()),
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ status: "400", scimType: "mutability" });
    const put = await scim("PUT", `/fabrikam/Users/${adminId}`, tokens.fabrikam, {
      userName: "admin@scim.test",
      externalId: randomUUID(),
    });
    expect(put.status).toBe(400);
    expect(put.json.scimType).toBe("mutability");
    const link = await h.admin.query(
      "SELECT subject FROM sso_identities WHERE user_id = $1 AND provider_id = $2",
      [adminId, providers.fabrikam],
    );
    expect(link.rows).toEqual([{ subject }]);
    expect(await sessionExists(sso)).toBe(true);
    // The same value (any case, for an Entra GUID) is no change.
    const same = await scim(
      "PATCH",
      `/fabrikam/Users/${adminId}`,
      tokens.fabrikam,
      patch("externalId", subject.toUpperCase()),
    );
    expect(same.status).toBe(200);
  });

  it("reactivates only users SCIM deactivated; an admin's deactivation stands (SSO11)", async () => {
    const t = tokens.contoso;
    const created = await scim("POST", "/contoso/Users", t, {
      userName: `fay.${randomUUID()}@contoso.com`,
      externalId: randomUUID(),
    });
    const id: string = created.json.id;
    const via = async () =>
      (await h.admin.query("SELECT deactivated_via FROM users WHERE id = $1", [id])).rows[0]
        .deactivated_via;

    // SCIM off, SCIM on: fine.
    expect((await scim("PATCH", `/contoso/Users/${id}`, t, patch("active", false))).status).toBe(
      200,
    );
    expect(await via()).toBe(`scim:${providers.contoso}`);
    const on = await scim("PATCH", `/contoso/Users/${id}`, t, patch("active", true));
    expect(on.json.active).toBe(true);
    expect(await via()).toBeNull();

    // A site admin deactivates: SCIM can't undo it.
    expect((await owner.post(`/v1/site/users/${id}/deactivate`)).status).toBe(200);
    expect(await via()).toBe("admin");
    const refused = await scim("PATCH", `/contoso/Users/${id}`, t, patch("active", true));
    expect(refused.status).toBe(403);
    expect(refused.json.detail).toMatch(/deactivated by a site admin/);
    const row = await h.admin.query("SELECT deactivated_at FROM users WHERE id = $1", [id]);
    expect(row.rows[0].deactivated_at).not.toBeNull();
    expect((await auditRows("identity.scim.reactivation_refused")).at(-1).target).toMatchObject({
      providerId: providers.contoso,
      userId: id,
    });
    const put = await scim("PUT", `/contoso/Users/${id}`, t, {
      userName: created.json.userName,
      externalId: created.json.externalId,
      active: true,
    });
    expect(put.status).toBe(403);

    // The admin reactivates; SCIM deactivates; the admin deactivates again (takes it over).
    expect((await owner.post(`/v1/site/users/${id}/reactivate`)).status).toBe(200);
    await scim("PATCH", `/contoso/Users/${id}`, t, patch("active", false));
    expect((await owner.post(`/v1/site/users/${id}/deactivate`)).status).toBe(200);
    expect(await via()).toBe("admin");
    expect((await scim("PATCH", `/contoso/Users/${id}`, t, patch("active", true))).status).toBe(
      403,
    );

    // A user SCIM created inactive is SCIM's to activate.
    const inactive = await scim("POST", "/contoso/Users", t, {
      userName: `gil.${randomUUID()}@contoso.com`,
      externalId: randomUUID(),
      active: false,
    });
    const gil = await scim("PATCH", `/contoso/Users/${inactive.json.id}`, t, patch("active", true));
    expect(gil.json.active).toBe(true);
  });

  it("protects the setup Owner by a durable flag, not by an audit row (finding 8)", async () => {
    const setup = await h.deps.createUserWithPassword(
      { email: "setup2@scim.test", name: "Setup", password: PASSWORD },
      { recordSetup: true },
    );
    const flag = await h.admin.query("SELECT setup_owner FROM users WHERE id = $1", [setup.id]);
    expect(flag.rows[0].setup_owner).toBe(true);
    // A setup Owner with no audit row at all (e.g. the log was pruned) stays protected.
    const bare = await h.createUser(`bare.${randomUUID()}@scim.test`);
    await h.admin.query("UPDATE users SET setup_owner = true WHERE id = $1", [bare]);
    await h.deps.database.db.insert(ssoIdentities).values({
      providerId: providers.contoso ?? "",
      subject: randomUUID(),
      userId: bare,
      linkedVia: "jit",
    });
    const res = await scim(
      "PATCH",
      `/contoso/Users/${bare}`,
      tokens.contoso,
      patch("active", false),
    );
    expect(res.status).toBe(403);
    const row = await h.admin.query("SELECT deactivated_at FROM users WHERE id = $1", [bare]);
    expect(row.rows[0].deactivated_at).toBeNull();
  });
});
