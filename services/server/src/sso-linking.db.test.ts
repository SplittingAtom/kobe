import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedHelmProviders } from "./sso/providers.js";
import { loadSsoSettings } from "./sso/settings.js";
import { resolver } from "./sso/testing.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, PASSWORD, type Harness } from "./testing/harness.js";
import { MockOidcProvider, routeMockOidc } from "./testing/mock-oidc.js";
import { totpFromUri } from "./testing/totp.js";
import { SoftwareAuthenticator } from "./testing/webauthn.js";

/**
 * KOBE-630 (spec sso-oidc-scim §6, SSO4, SSO9, SSO10): account linking. Email never links on its
 * own; a local sign-in as the same user after the SSO attempt links (`local_proof`); a different
 * local user discards the intent; an admin-expected link needs a verified address in one of the
 * provider's verified domains and is single use; unlinking ends that provider's sessions and is
 * refused for the only way to sign in; linked local users keep local sign-in; the setup Owner is
 * never linked by expectation and no SSO session removes its passkey.
 */
const TENANT = "21111111-2222-4333-8444-555555555555";
const ENTRA = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const KC = "https://kc-link.example.com/realms/kobe";
const CORP_SECRET = "Corp~Secret.Value-0123456789abcdef";
const KC_SECRET = "Kc~Secret.Value-0123456789abcdefgh";
const LINK_COOKIE = "kobe-sso-link";

let h: Harness;
let entra: MockOidcProvider;
let kc: MockOidcProvider;
let owner: TestBrowser;
let ownerId = "";
let corpId = "";
let kcId = "";
let nextOid = 1;
const oid = () => `00000000-0000-4000-9000-${String(nextOid++).padStart(12, "0")}`;
let nextUser = 1;
const address = (label: string, domain = "contoso.com") => `${label}-${nextUser++}@${domain}`;

beforeAll(async () => {
  entra = await MockOidcProvider.create({
    issuer: ENTRA,
    clientId: "corp-app",
    clientSecret: CORP_SECRET,
    tenantId: TENANT,
    discovery: { code_challenge_methods_supported: undefined },
  });
  kc = await MockOidcProvider.create({ issuer: KC, clientId: "kc-app", clientSecret: KC_SECRET });
  const settings = loadSsoSettings({
    KOBE_SSO_ENABLED: "true",
    KOBE_SSO_PROVIDERS: JSON.stringify([
      {
        slug: "corp",
        displayName: "Contoso",
        kind: "entra",
        tenantId: TENANT,
        clientId: "corp-app",
        allowedEmailDomains: ["contoso.com"],
      },
      {
        slug: "kc",
        displayName: "Keycloak",
        kind: "oidc",
        issuer: KC,
        clientId: "kc-app",
        accessClaim: "groups",
        allowedEmailDomains: ["kc.test"],
      },
    ]),
    KOBE_SSO_CLIENT_SECRET_CORP: CORP_SECRET,
    KOBE_SSO_CLIENT_SECRET_KC: KC_SECRET,
  });
  h = await openHarness({
    sso: { settings, net: { resolve: resolver() }, request: routeMockOidc(entra, kc) },
  });
  await seedHelmProviders(h.deps.database.db, settings);
  ownerId = await h.createUser("owner@contoso.com", "owner");
  await h.admin.query(`UPDATE users SET setup_owner = true WHERE id = $1`, [ownerId]);
  owner = await h.signIn("owner@contoso.com");
  const team = await owner.post("/v1/site/teams", {
    slug: "research",
    name: "Research",
    adminUserId: ownerId,
  });
  expect(team.status, JSON.stringify(team.json)).toBe(201);
  const { rows } = await h.admin.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM sso_providers`,
  );
  corpId = rows.find((r) => r.slug === "corp")?.id ?? "";
  kcId = rows.find((r) => r.slug === "kc")?.id ?? "";
  for (const [providerId, claimValue] of [
    [corpId, "kobe.research.member"],
    [kcId, "g-research"],
  ] as const) {
    const res = await owner.post(`/v1/site/sso/providers/${providerId}/mappings`, {
      claimValue,
      teamId: team.json.team.id,
      role: "member",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
  }
});
afterAll(async () => {
  await h?.close();
});

/** An Entra member identity whose UPN (verified in contoso.com) is `upn`. */
const entraUser = (upn: string, over: Record<string, unknown> = {}) => ({
  oid: oid(),
  name: "Grace Hopper",
  upn,
  roles: ["kobe.research.member"],
  amr: ["pwd", "mfa"],
  auth_time: Math.floor(Date.now() / 1000) - 5,
  ...over,
});

/** Runs an SSO sign-in in `browser` and returns the sign-in page's error code (null: signed in). */
async function sso(
  user: Record<string, unknown>,
  browser = h.browser(),
  mock = entra,
  slug = "corp",
): Promise<string | null> {
  const start = await browser.get(`/api/auth/sso/start/${slug}`);
  expect(start.status, start.text).toBe(302);
  const cb = mock.authorize(start.headers.get("location") ?? "", user);
  const res = await browser.get(`${cb.pathname}${cb.search}`);
  expect(res.status, res.text).toBe(302);
  return new URL(res.headers.get("location") ?? "").searchParams.get("sso_error");
}

async function passwordSignIn(browser: TestBrowser, email: string) {
  const res = await browser.post("/api/auth/sign-in/email", { email, password: PASSWORD });
  expect(res.status, res.text).toBe(200);
  return res;
}

/** The confirmation step (review M1): the staged identity, then POST confirm. */
async function confirmLink(browser: TestBrowser, provider = "Contoso") {
  const pending = await browser.get("/v1/me/sso/pending-link");
  expect(pending.status, pending.text).toBe(200);
  expect(pending.json.pending).toMatchObject({ providerName: provider });
  const res = await browser.post("/v1/me/sso/pending-link/confirm");
  expect(res.status, res.text).toBe(200);
}

async function linksOf(userId: string) {
  const { rows } = await h.admin.query<{
    provider_id: string;
    subject: string;
    linked_via: string;
  }>(`SELECT provider_id, subject, linked_via FROM sso_identities WHERE user_id = $1`, [userId]);
  return rows;
}

async function audits(action: string, userId: string) {
  const { rows } = await h.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE action = $1 AND target ->> 'userId' = $2 ORDER BY id`,
    [action, userId],
  );
  return rows.map((r) => r.target);
}

async function me(browser: TestBrowser) {
  const res = await browser.get("/v1/me");
  return res.status === 200 ? (res.json.user.id as string) : null;
}

describe("local proof (§6)", () => {
  it("ac-1: the same email never links on its own", async () => {
    const email = address("same");
    const userId = await h.createUser(email);
    const b = h.browser();
    expect(await sso(entraUser(email, { email, xms_edov: true }), b)).toBe("not_allowed");
    expect(await me(b)).toBeNull();
    expect(b.cookies.has(LINK_COOKIE)).toBe(true);
    expect(await linksOf(userId)).toEqual([]);
    // Signing in again through SSO still does not link, and no session is made.
    expect(await sso(entraUser(email), h.browser())).toBe("not_allowed");
    expect(await linksOf(userId)).toEqual([]);
  });

  it("links after a local password sign-in as the same user; local sign-in keeps working (SSO9)", async () => {
    const email = address("proof");
    const userId = await h.createUser(email);
    const idp = entraUser(email);
    const b = h.browser();
    expect(await sso(idp, b)).toBe("not_allowed");
    await passwordSignIn(b, email);
    expect(b.cookies.has(LINK_COOKIE)).toBe(false);
    // Review M1: nothing is linked until the signed-in user confirms on the next screen.
    expect(await linksOf(userId)).toEqual([]);
    expect((await b.get("/v1/me/sso/pending-link")).json.pending).toEqual({
      providerId: corpId,
      providerName: "Contoso",
      email,
    });
    await confirmLink(b);
    expect(await linksOf(userId)).toEqual([
      { provider_id: corpId, subject: idp.oid, linked_via: "local_proof" },
    ]);
    expect(await audits("identity.sso.link.created", userId)).toEqual([
      { providerId: corpId, userId, method: "local_proof" },
    ]);
    // The identity now signs in as that user; the password still works; the local session can
    // add a passkey (a linked local user keeps local credentials).
    const again = h.browser();
    expect(await sso(idp, again)).toBeNull();
    expect(await me(again)).toBe(userId);
    const local = await h.signIn(email);
    const options = await local.get("/api/auth/passkey/generate-register-options");
    expect(options.status, options.text).toBe(200);
    // ...and a password reset is still mailed (they have a password).
    const sent = h.mailer.sent.length;
    await h.browser().post("/api/auth/request-password-reset", {
      email,
      redirectTo: "/reset-password",
    });
    await h.deps.background.idle();
    expect(h.mailer.sent.length).toBe(sent + 1);
    // KOBE-629: that identity's SSO session without MFA proof still can't add a credential.
    const weak = h.browser();
    expect(await sso({ ...idp, amr: ["pwd"] }, weak)).toBeNull();
    const pk = await weak.get("/api/auth/passkey/generate-register-options");
    expect(pk.status).toBe(403);
    expect(pk.json.code).toBe("SSO_MFA_REQUIRED");
  });

  it("links only once the TOTP step of a local sign-in completes", async () => {
    const email = address("totp");
    const userId = await h.createUser(email);
    const setup = await h.signIn(email);
    const enable = await setup.post("/api/auth/two-factor/enable", { password: PASSWORD });
    const uri = enable.json.totpURI as string;
    expect(
      (await setup.post("/api/auth/two-factor/verify-totp", { code: totpFromUri(uri) })).status,
    ).toBe(200);
    const idp = entraUser(email);
    const b = h.browser();
    expect(await sso(idp, b)).toBe("not_allowed");
    const first = await passwordSignIn(b, email);
    expect(first.json.twoFactorRedirect).toBe(true);
    expect(await linksOf(userId)).toEqual([]);
    expect(b.cookies.has(LINK_COOKIE)).toBe(true);
    const second = await b.post("/api/auth/two-factor/verify-totp", { code: totpFromUri(uri) });
    expect(second.status, second.text).toBe(200);
    await confirmLink(b);
    expect((await linksOf(userId)).map((l) => l.linked_via)).toEqual(["local_proof"]);
  });

  it("links after a passkey sign-in as the same user", async () => {
    const email = address("passkey");
    const userId = await h.createUser(email);
    const authenticator = new SoftwareAuthenticator("kobe.test", "http://kobe.test");
    const local = await h.signIn(email);
    const options = await local.get("/api/auth/passkey/generate-register-options");
    const registered = await local.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register(options.json),
      name: "key",
    });
    expect(registered.status, registered.text).toBe(200);
    const b = h.browser();
    expect(await sso(entraUser(email), b)).toBe("not_allowed");
    const authOptions = await b.get("/api/auth/passkey/generate-authenticate-options");
    const verified = await b.post("/api/auth/passkey/verify-authentication", {
      response: authenticator.authenticate(authOptions.json),
    });
    expect(verified.status, verified.text).toBe(200);
    await confirmLink(b);
    expect((await linksOf(userId)).map((l) => l.linked_via)).toEqual(["local_proof"]);
  });

  it("ac-2: a different local user signing in discards the intent and links nothing", async () => {
    const email = address("victim");
    const victimId = await h.createUser(email);
    const otherEmail = address("other");
    const otherId = await h.createUser(otherEmail);
    const b = h.browser();
    expect(await sso(entraUser(email), b)).toBe("not_allowed");
    const spent = b.cookies.get(LINK_COOKIE) ?? "";
    expect(spent).not.toBe("");
    await passwordSignIn(b, otherEmail);
    expect(b.cookies.has(LINK_COOKIE)).toBe(false);
    expect(await linksOf(otherId)).toEqual([]);
    expect((await b.get("/v1/me/sso/pending-link")).json.pending).toBeNull();
    expect((await b.post("/v1/me/sso/pending-link/confirm")).status).toBe(404);
    // The intent is spent server-side too: replaying its cookie with the right user links nothing.
    const replay = h.browser();
    replay.cookies.set(LINK_COOKIE, spent);
    await passwordSignIn(replay, email);
    expect((await replay.get("/v1/me/sso/pending-link")).json.pending).toBeNull();
    expect(await linksOf(victimId)).toEqual([]);
    expect(await audits("identity.sso.link.created", victimId)).toEqual([]);
  });

  it("a failed password attempt keeps the intent; a forged cookie links nothing", async () => {
    const email = address("retry");
    const userId = await h.createUser(email);
    const b = h.browser();
    expect(await sso(entraUser(email), b)).toBe("not_allowed");
    const wrong = await b.post("/api/auth/sign-in/email", { email, password: "not the password" });
    expect(wrong.status).toBe(401);
    expect(b.cookies.has(LINK_COOKIE)).toBe(true);
    await passwordSignIn(b, email);
    await confirmLink(b);
    expect((await linksOf(userId)).map((l) => l.linked_via)).toEqual(["local_proof"]);

    const forgedEmail = address("forged");
    const forgedId = await h.createUser(forgedEmail);
    const forged = h.browser();
    forged.cookies.set(LINK_COOKIE, "A".repeat(120));
    await passwordSignIn(forged, forgedEmail);
    expect(await linksOf(forgedId)).toEqual([]);
  });

  it("review M1: an unverified address gets no intent at all", async () => {
    const email = address("self-set", "kc.test");
    const userId = await h.createUser(email);
    const b = h.browser();
    const unverified = { sub: `kc-${oid()}`, email, email_verified: false, groups: ["g-research"] };
    expect(await sso(unverified, b, kc, "kc")).toBe("not_allowed");
    expect(b.cookies.has(LINK_COOKIE)).toBe(false);
    await passwordSignIn(b, email);
    expect((await b.get("/v1/me/sso/pending-link")).json.pending).toBeNull();
    expect(await linksOf(userId)).toEqual([]);
  });

  it("review M1: a staged link can be declined, and belongs to the session that signed in", async () => {
    const email = address("decline");
    const userId = await h.createUser(email);
    const b = h.browser();
    expect(await sso(entraUser(email), b)).toBe("not_allowed");
    await passwordSignIn(b, email);
    // Another session of the same user sees nothing to confirm.
    const other = await h.signIn(email);
    expect((await other.get("/v1/me/sso/pending-link")).json.pending).toBeNull();
    expect((await other.post("/v1/me/sso/pending-link/confirm")).status).toBe(404);
    // A cross-origin confirmation is refused by the API's CSRF check.
    const csrf = await b.request(
      "POST",
      "/v1/me/sso/pending-link/confirm",
      {},
      {
        origin: "https://evil.example",
      },
    );
    expect(csrf.status).toBe(403);
    expect((await b.delete("/v1/me/sso/pending-link")).status).toBe(200);
    expect((await b.post("/v1/me/sso/pending-link/confirm")).status).toBe(404);
    expect(await linksOf(userId)).toEqual([]);
    expect(await audits("identity.sso.link.created", userId)).toEqual([]);
  });

  it("an unmapped identity gets the same answer and intent (nothing tells the address exists)", async () => {
    const b = h.browser();
    expect(await sso(entraUser(address("nobody"), { roles: [] }), b)).toBe("not_allowed");
    expect(b.cookies.has(LINK_COOKIE)).toBe(true);
  });
});

describe("admin-expected links (§6)", () => {
  const expect_ = (userId: string, providerId = corpId, as = owner) =>
    as.put(`/v1/site/sso/users/${userId}/link-expectations/${providerId}`);

  it("ac-3: an expectation needs the user's domain among the provider's verified domains", async () => {
    const userId = await h.createUser(address("elsewhere", "fabrikam.test"));
    const res = await expect_(userId);
    expect(res.status, res.text).toBe(409);
    expect(res.json.code).toBe("domain_not_verified");
    const { rows } = await h.admin.query(`SELECT 1 FROM sso_link_expectations WHERE user_id = $1`, [
      userId,
    ]);
    expect(rows).toHaveLength(0);
    expect(await audits("identity.sso.link_expected", userId)).toEqual([]);
  });

  it("links the next verified sign-in once, audited, and consumes the expectation", async () => {
    const email = address("expected");
    const userId = await h.createUser(email);
    const res = await expect_(userId);
    expect(res.status, res.text).toBe(200);
    expect(res.json.expectation.providerName).toBe("Contoso");
    const days = (Date.parse(res.json.expectation.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    expect(await audits("identity.sso.link_expected", userId)).toEqual([
      { providerId: corpId, userId },
    ]);
    const listed = await owner.get(`/v1/site/sso/users/${userId}/links`);
    expect(listed.json.expectations).toHaveLength(1);

    const idp = entraUser(email);
    const b = h.browser();
    expect(await sso(idp, b)).toBeNull();
    expect(await me(b)).toBe(userId);
    expect(await linksOf(userId)).toEqual([
      { provider_id: corpId, subject: idp.oid, linked_via: "admin_expected" },
    ]);
    expect(await audits("identity.sso.link.created", userId)).toEqual([
      { providerId: corpId, userId, method: "admin_expected" },
    ]);
    const after = await owner.get(`/v1/site/sso/users/${userId}/links`);
    expect(after.json.expectations).toEqual([]);
    expect(after.json.links).toMatchObject([{ providerId: corpId, linkedVia: "admin_expected" }]);
    // Single use: another identity with the same address does not link.
    expect(await sso(entraUser(email), h.browser())).toBe("not_allowed");
    // Already linked: a new expectation is refused.
    expect((await expect_(userId)).json.code).toBe("already_linked");
  });

  it("does not link an unverified address, or once the expectation expired", async () => {
    const email = address("unverified", "kc.test");
    const userId = await h.createUser(email);
    expect((await expect_(userId, kcId)).status).toBe(200);
    const unverified = { sub: `kc-${oid()}`, email, groups: ["g-research"] };
    expect(await sso(unverified, h.browser(), kc, "kc")).toBe("not_allowed");
    expect(await linksOf(userId)).toEqual([]);
    await h.admin.query(
      `UPDATE sso_link_expectations SET created_at = now() - interval '15 days',
              expires_at = now() - interval '1 day' WHERE user_id = $1`,
      [userId],
    );
    const verified = { ...unverified, email_verified: true };
    expect(await sso(verified, h.browser(), kc, "kc")).toBe("not_allowed");
    expect(await linksOf(userId)).toEqual([]);
  });

  it("SSO10 + review M3: refuses an expectation for the setup Owner and any site Admin", async () => {
    const res = await expect_(ownerId);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("protected_user");
    const adminId = await h.createUser(address("site-admin"), "admin");
    const admin = await expect_(adminId);
    expect(admin.status).toBe(409);
    expect(admin.json.code).toBe("protected_user");
    // Promoted after the expectation: refused at link time too.
    const email = address("promoted");
    const userId = await h.createUser(email);
    expect((await expect_(userId)).status).toBe(200);
    await h.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [userId]);
    expect(await sso(entraUser(email), h.browser())).toBe("not_allowed");
    expect(await linksOf(userId)).toEqual([]);
  });

  it("withdraws an expectation (audited); only the Owner acts on Admins", async () => {
    const userId = await h.createUser(address("withdraw"));
    expect((await expect_(userId)).status).toBe(200);
    const gone = await owner.delete(`/v1/site/sso/users/${userId}/link-expectations/${corpId}`);
    expect(gone.status, gone.text).toBe(200);
    expect(await audits("identity.sso.link_expectation.withdrawn", userId)).toEqual([
      { providerId: corpId, userId },
    ]);
    const again = await owner.delete(`/v1/site/sso/users/${userId}/link-expectations/${corpId}`);
    expect(again.status).toBe(404);

    const adminEmail = address("admin");
    await h.createUser(adminEmail, "admin");
    const otherAdminId = await h.createUser(address("admin2"), "admin");
    const admin = await h.signIn(adminEmail);
    const refused = await expect_(otherAdminId, corpId, admin);
    expect(refused.status).toBe(403);
    expect((await expect_(userId, corpId, admin)).status).toBe(200);
  });
});

describe("unlink (§6, §9)", () => {
  /** A local user linked to an Entra identity by local proof, with an SSO and a local session. */
  async function linkedLocal(label: string) {
    const email = address(label);
    const userId = await h.createUser(email);
    const idp = entraUser(email);
    const b = h.browser();
    expect(await sso(idp, b)).toBe("not_allowed");
    await passwordSignIn(b, email);
    await confirmLink(b);
    const ssoBrowser = h.browser();
    expect(await sso(idp, ssoBrowser)).toBeNull();
    return { email, userId, idp, local: b, ssoBrowser };
  }

  it("Me: unlinks, ends that provider's sessions and keeps local ones (audited)", async () => {
    const who = await linkedLocal("unlink-me");
    const list = await who.local.get("/v1/me/sso/links");
    expect(list.status).toBe(200);
    expect(list.json.links).toMatchObject([{ providerId: corpId, linkedVia: "local_proof" }]);
    const res = await who.local.delete(`/v1/me/sso/links/${corpId}`);
    expect(res.status, res.text).toBe(200);
    expect(res.json.sessionsEnded).toBe(1);
    expect(await me(who.ssoBrowser)).toBeNull();
    expect(await me(who.local)).toBe(who.userId);
    expect(await linksOf(who.userId)).toEqual([]);
    expect(await audits("identity.sso.link.removed", who.userId)).toEqual([
      { providerId: corpId, userId: who.userId, by: "user", sessionsEnded: 1 },
    ]);
    expect((await who.local.delete(`/v1/me/sso/links/${corpId}`)).status).toBe(404);
  });

  it("refuses to unlink the only way to sign in (an SSO-made user)", async () => {
    const b = h.browser();
    expect(await sso(entraUser(address("jit")), b)).toBeNull();
    const userId = (await me(b)) ?? "";
    const res = await b.delete(`/v1/me/sso/links/${corpId}`);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("last_sign_in_method");
    expect(await linksOf(userId)).toHaveLength(1);
    expect(await me(b)).toBe(userId);
    const byAdmin = await owner.delete(`/v1/site/sso/users/${userId}/links/${corpId}`);
    expect(byAdmin.status).toBe(409);
  });

  it("review M2: an SSO session Better Auth rotates (TOTP enrolment, password change) still ends at unlink", async () => {
    const who = await linkedLocal("rotate");
    const enable = await who.ssoBrowser.post("/api/auth/two-factor/enable", {
      password: PASSWORD,
    });
    expect(enable.status, enable.text).toBe(200);
    const before = (await who.ssoBrowser.get("/v1/me")).status;
    expect(before).toBe(200);
    const verify = await who.ssoBrowser.post("/api/auth/two-factor/verify-totp", {
      code: totpFromUri(enable.json.totpURI as string),
    });
    expect(verify.status, verify.text).toBe(200);
    const change = await who.ssoBrowser.post("/api/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expect(change.status, change.text).toBe(200);
    const { rows } = await h.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions s JOIN session_sso_contexts c ON c.session_id = s.id
        WHERE s.user_id = $1`,
      [who.userId],
    );
    expect(rows[0]?.n).toBe(1);
    expect(await me(who.ssoBrowser)).toBe(who.userId);
    const res = await owner.delete(`/v1/site/sso/users/${who.userId}/links/${corpId}`);
    expect(res.status, res.text).toBe(200);
    expect(res.json.sessionsEnded).toBe(1);
    expect(await me(who.ssoBrowser)).toBeNull();
  });

  it("review M2: a non-MFA SSO session can't turn two-factor off", async () => {
    const who = await linkedLocal("disable");
    const enable = await who.local.post("/api/auth/two-factor/enable", { password: PASSWORD });
    await who.local.post("/api/auth/two-factor/verify-totp", {
      code: totpFromUri(enable.json.totpURI as string),
    });
    const weak = h.browser();
    expect(await sso({ ...who.idp, amr: ["pwd"] }, weak)).toBeNull();
    const off = await weak.post("/api/auth/two-factor/disable", { password: PASSWORD });
    expect(off.status).toBe(403);
    expect(off.json.code).toBe("SSO_MFA_REQUIRED");
    const { rows } = await h.admin.query(`SELECT two_factor_enabled FROM users WHERE id = $1`, [
      who.userId,
    ]);
    expect(rows[0]).toEqual({ two_factor_enabled: true });
  });

  it("review L2: a link to a disabled provider is no way to sign in; nor is a removed passkey", async () => {
    const b = h.browser();
    expect(await sso(entraUser(address("two-links")), b)).toBeNull();
    const userId = (await me(b)) ?? "";
    await h.admin.query(
      `INSERT INTO sso_identities (provider_id, subject, user_id, linked_via) VALUES ($1, $2, $3, 'jit')`,
      [kcId, `kc-${oid()}`, userId],
    );
    await h.admin.query(`UPDATE sso_providers SET enabled = false WHERE id = $1`, [kcId]);
    try {
      const res = await b.delete(`/v1/me/sso/links/${corpId}`);
      expect(res.status).toBe(409);
      expect(res.json.code).toBe("last_sign_in_method");
    } finally {
      await h.admin.query(`UPDATE sso_providers SET enabled = true WHERE id = $1`, [kcId]);
    }

    // A passkey-only account (no password, no link) keeps its last passkey.
    const email = address("pk-only");
    const pkUser = await h.createUser(email);
    const authenticator = new SoftwareAuthenticator("kobe.test", "http://kobe.test");
    const local = await h.signIn(email);
    const options = await local.get("/api/auth/passkey/generate-register-options");
    await local.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register(options.json),
      name: "only",
    });
    await h.admin.query(`DELETE FROM accounts WHERE user_id = $1`, [pkUser]);
    const { rows } = await h.admin.query<{ id: string }>(
      `SELECT id FROM passkeys WHERE user_id = $1`,
      [pkUser],
    );
    const del = await local.post("/api/auth/passkey/delete-passkey", { id: rows[0]?.id });
    expect(del.status).toBe(403);
    expect(del.json.code).toBe("LAST_SIGN_IN_METHOD");
  });

  it("Site console: an admin unlinks (audited by: admin)", async () => {
    const who = await linkedLocal("unlink-admin");
    const res = await owner.delete(`/v1/site/sso/users/${who.userId}/links/${corpId}`);
    expect(res.status, res.text).toBe(200);
    expect(await me(who.ssoBrowser)).toBeNull();
    expect(await audits("identity.sso.link.removed", who.userId)).toMatchObject([
      { by: "admin", sessionsEnded: 1 },
    ]);
  });
});

describe("the setup Owner keeps local sign-in (SSO10)", () => {
  it("links by its own local proof, keeps password and passkey, and no SSO session removes them", async () => {
    const authenticator = new SoftwareAuthenticator("kobe.test", "http://kobe.test");
    const local = await h.signIn("owner@contoso.com");
    const options = await local.get("/api/auth/passkey/generate-register-options");
    const registered = await local.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register(options.json),
      name: "break-glass",
    });
    expect(registered.status, registered.text).toBe(200);
    const idp = entraUser("owner@contoso.com");
    const b = h.browser();
    expect(await sso(idp, b)).toBe("not_allowed");
    await passwordSignIn(b, "owner@contoso.com");
    await confirmLink(b);
    expect((await linksOf(ownerId)).map((l) => l.linked_via)).toEqual(["local_proof"]);

    const ssoSession = h.browser();
    expect(await sso(idp, ssoSession)).toBeNull();
    expect(await me(ssoSession)).toBe(ownerId);
    const { rows } = await h.admin.query<{ id: string }>(
      `SELECT id FROM passkeys WHERE user_id = $1`,
      [ownerId],
    );
    const del = await ssoSession.post("/api/auth/passkey/delete-passkey", { id: rows[0]?.id });
    expect(del.status, del.text).toBe(403);
    expect(del.json.code).toBe("SETUP_OWNER_LOCAL_ONLY");
    const unlinkAccount = await ssoSession.post("/api/auth/unlink-account", {
      providerId: "credential",
    });
    expect(unlinkAccount.status).toBe(403);
    expect(unlinkAccount.json.code).toBe("SETUP_OWNER_LOCAL_ONLY");
    // Review L3: nor its authenticator app.
    const off = await ssoSession.post("/api/auth/two-factor/disable", { password: PASSWORD });
    expect(off.status).toBe(403);
    expect(off.json.code).toBe("SETUP_OWNER_LOCAL_ONLY");
    const creds = await h.admin.query(
      `SELECT (SELECT count(*)::int FROM passkeys WHERE user_id = $1) AS passkeys,
              (SELECT count(*)::int FROM accounts WHERE user_id = $1 AND provider_id = 'credential') AS passwords`,
      [ownerId],
    );
    expect(creds.rows[0]).toEqual({ passkeys: 1, passwords: 1 });
    // Unlinking leaves local sign-in as it was.
    expect((await local.delete(`/v1/me/sso/links/${corpId}`)).status).toBe(200);
    await passwordSignIn(h.browser(), "owner@contoso.com");
  });
});
