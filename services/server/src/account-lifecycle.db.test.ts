import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, PASSWORD, PUBLIC_URL, type Harness } from "./testing/harness.js";
import { totpFromUri } from "./testing/totp.js";
import { SoftwareAuthenticator } from "./testing/webauthn.js";

// KOBE-13 ac-3 (password reset) and ac-4 (deactivation, reactivation).
let h: Harness;
const ids = { owner: "", admin: "", admin2: "", uma: "", tess: "", pat: "", rita: "" };
let owner: TestBrowser;
let installAdmin: TestBrowser;

beforeAll(async () => {
  h = await openHarness();
  ids.owner = await h.createUser("owner@life.test", "owner");
  ids.admin = await h.createUser("admin@life.test", "admin");
  ids.admin2 = await h.createUser("admin2@life.test", "admin");
  ids.uma = await h.createUser("uma@life.test");
  ids.tess = await h.createUser("tess@life.test");
  ids.pat = await h.createUser("pat@life.test");
  ids.rita = await h.createUser("rita@life.test");
  owner = await h.signIn("owner@life.test");
  installAdmin = await h.signIn("admin@life.test");
});

afterAll(async () => {
  await h?.close();
});

const requestReset = (email: string, b: TestBrowser = h.browser()) =>
  b.post("/api/auth/request-password-reset", { email });

async function resetToken(email: string): Promise<string> {
  await h.mailer.settle();
  return h.mailer.lastToken(email);
}

describe("password reset (ac-3)", () => {
  it("answers the same for known and unknown addresses, and mails only real accounts", async () => {
    const known = await requestReset("rita@life.test");
    const unknown = await requestReset("nobody@life.test");
    expect(known.status).toBe(200);
    expect(unknown).toEqual(known);
    await h.mailer.settle();
    expect(h.mailer.to("nobody@life.test")).toEqual([]);
    const [mail] = h.mailer.to("rita@life.test");
    expect(mail?.subject).toBe("Reset your Kobe password");
    expect(mail?.text).toContain(`${PUBLIC_URL}/reset-password#token=`);
    expect(mail?.text).toContain("30 minutes");
  });

  it("stores the token only hashed", async () => {
    const token = await resetToken("rita@life.test");
    const { rows } = await h.admin.query(`SELECT identifier, value FROM verifications`);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("sets a new password once, and signs the user out everywhere", async () => {
    const before = await h.signIn("rita@life.test");
    const token = await resetToken("rita@life.test");
    const res = await h
      .browser()
      .post("/api/auth/reset-password", { token, newPassword: "a fresh new password" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await before.get("/v1/me")).status).toBe(401);
    const old = await h
      .browser()
      .post("/api/auth/sign-in/email", { email: "rita@life.test", password: PASSWORD });
    expect(old.status).toBe(401);
    await h.signIn("rita@life.test", "a fresh new password");
    const reused = await h
      .browser()
      .post("/api/auth/reset-password", { token, newPassword: "yet another password" });
    expect(reused.status).toBe(400);
  });

  it("refuses an expired token", async () => {
    await requestReset("pat@life.test");
    const token = await resetToken("pat@life.test");
    await h.admin.query(
      `UPDATE verifications SET expires_at = now() - interval '1 minute' WHERE value = $1`,
      [ids.pat],
    );
    const res = await h
      .browser()
      .post("/api/auth/reset-password", { token, newPassword: "a fresh new password" });
    expect(res.status).toBe(400);
    await h.signIn("pat@life.test");
  });

  it("enforces the password policy", async () => {
    await requestReset("pat@life.test");
    const token = await resetToken("pat@life.test");
    const res = await h.browser().post("/api/auth/reset-password", { token, newPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("rate-limits requests per client IP", async () => {
    const ip = { "x-forwarded-for": "198.51.100.251" };
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const res = await h
        .browser()
        .request("POST", "/api/auth/request-password-reset", { email: "x@life.test" }, ip);
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  /** Pretends the last reset email to this user went out `minutes` ago. */
  const ageResetMail = (userId: string, minutes: number) =>
    h.admin.query(
      `UPDATE rate_limits SET last_request = last_request - $2::bigint WHERE key LIKE $1`,
      [`kobe:reset-sent:${userId}:%`, minutes * 60_000],
    );

  it("sends one email while a recently mailed link is still valid, whatever the client IPs", async () => {
    await h.admin.query(`DELETE FROM rate_limits`);
    const sentBefore = h.mailer.to("tess@life.test").length;
    for (let i = 0; i < 5; i++) expect((await requestReset("tess@life.test")).status).toBe(200);
    await h.mailer.settle();
    expect(h.mailer.to("tess@life.test").length - sentBefore).toBe(1);
  });

  it("never lets an attacker's requests block a real request later in the hour", async () => {
    // The attacker kept requesting; the owner of the account asks ten minutes later.
    await ageResetMail(ids.tess, 10);
    const sentBefore = h.mailer.to("tess@life.test").length;
    expect((await requestReset("tess@life.test")).status).toBe(200);
    await h.mailer.settle();
    expect(h.mailer.to("tess@life.test").length - sentBefore).toBe(1);
    const token = h.mailer.lastToken("tess@life.test");
    const res = await h
      .browser()
      .post("/api/auth/reset-password", { token, newPassword: PASSWORD });
    expect(res.status).toBe(200);
    // Used: the next request is mailed at once.
    const before = h.mailer.to("tess@life.test").length;
    await requestReset("tess@life.test");
    await h.mailer.settle();
    expect(h.mailer.to("tess@life.test").length - before).toBe(1);
    await h.admin.query(`UPDATE verifications SET expires_at = now() WHERE value = $1`, [ids.tess]);
  });

  it("doesn't count a failed delivery", async () => {
    const before = h.mailer.to("pat@life.test").length;
    await ageResetMail(ids.pat, 60);
    h.mailer.failNext = new Error("SMTP down");
    await requestReset("pat@life.test");
    await h.mailer.settle();
    expect(h.mailer.to("pat@life.test").length).toBe(before);
    await requestReset("pat@life.test");
    await h.mailer.settle();
    expect(h.mailer.to("pat@life.test").length).toBe(before + 1);
  });

  it("invalidates other reset links when the password is reset or changed", async () => {
    // Reset: two links mailed; using the second kills the first.
    await ageResetMail(ids.pat, 60);
    const first = h.mailer.lastToken("pat@life.test");
    await ageResetMail(ids.pat, 60);
    await requestReset("pat@life.test");
    const second = await resetToken("pat@life.test");
    expect(second).not.toBe(first);
    const ok = await h
      .browser()
      .post("/api/auth/reset-password", { token: second, newPassword: "pat's new password" });
    expect(ok.status).toBe(200);
    const stale = await h
      .browser()
      .post("/api/auth/reset-password", { token: first, newPassword: "an attacker password" });
    expect(stale.status).toBe(400);

    // Change: a mailed link dies when the signed-in user changes the password.
    await ageResetMail(ids.pat, 60);
    await requestReset("pat@life.test");
    const pending = await resetToken("pat@life.test");
    const pat = await h.signIn("pat@life.test", "pat's new password");
    const changed = await pat.post("/api/auth/change-password", {
      currentPassword: "pat's new password",
      newPassword: PASSWORD,
    });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    const late = await h
      .browser()
      .post("/api/auth/reset-password", { token: pending, newPassword: "an attacker password" });
    expect(late.status).toBe(400);
    await h.signIn("pat@life.test");
  });
});

describe("deactivation (ac-4)", () => {
  const authenticator = new SoftwareAuthenticator("kobe.test", PUBLIC_URL);
  let umaTotp = "";
  let team = "";

  beforeAll(async () => {
    // Uma: team admin of "ops" (with Tess as second admin), TOTP and a passkey enrolled.
    const uma = await h.signIn("uma@life.test");
    const enable = await uma.post("/api/auth/two-factor/enable", { password: PASSWORD });
    umaTotp = enable.json.totpURI;
    await uma.post("/api/auth/two-factor/verify-totp", { code: totpFromUri(umaTotp) });
    const options = await uma.get("/api/auth/passkey/generate-register-options");
    const reg = await uma.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register(options.json),
    });
    expect(reg.status, JSON.stringify(reg.json)).toBe(200);
    const created = await owner.post("/v1/install/teams", {
      slug: "ops",
      name: "Ops",
      adminUserId: ids.uma,
    });
    team = created.json.team.id;
    await uma.put("/v1/me/teams/active", { teamId: team });
    uma.team = team;
    await uma.post("/v1/team/invites", { email: "tess@life.test", role: "team_admin" });
    const tess = await h.signIn("tess@life.test");
    expect((await tess.post(`/v1/me/invites/${team}/accept`)).status).toBe(200);
  });

  async function signInUmaWithTotp(): Promise<{ status: number }> {
    const b = h.browser();
    const first = await b.post("/api/auth/sign-in/email", {
      email: "uma@life.test",
      password: PASSWORD,
    });
    if (first.status !== 200 || !first.json.twoFactorRedirect) return first;
    return b.post("/api/auth/two-factor/verify-totp", { code: totpFromUri(umaTotp) });
  }

  async function signInUmaWithPasskey(): Promise<{ status: number; browser: TestBrowser }> {
    const b = h.browser();
    const options = await b.get("/api/auth/passkey/generate-authenticate-options");
    const res = await b.post("/api/auth/passkey/verify-authentication", {
      response: authenticator.authenticate(options.json),
    });
    return { status: res.status, browser: b };
  }

  it("is for install admins, and only the Owner acts on Admins", async () => {
    const pat = await h.signIn("pat@life.test");
    expect((await pat.post(`/v1/install/users/${ids.uma}/deactivate`)).status).toBe(403);
    expect((await pat.get("/v1/install/users")).status).toBe(403);
    expect((await installAdmin.post(`/v1/install/users/${ids.admin2}/deactivate`)).status).toBe(
      403,
    );
    expect(await installAdmin.post(`/v1/install/users/${ids.owner}/deactivate`)).toMatchObject({
      status: 409,
      json: { code: "owner_cannot_be_deactivated" },
    });
    expect(await installAdmin.post(`/v1/install/users/${ids.admin}/deactivate`)).toMatchObject({
      status: 400,
      json: { code: "cannot_change_self" },
    });
    expect(
      (await installAdmin.post(`/v1/install/users/00000000-0000-4000-8000-000000000000/deactivate`))
        .status,
    ).toBe(404);
  });

  it("ends every session, blocks every sign-in method and all API access at once", async () => {
    const live = await signInUmaWithTotp();
    expect(live.status).toBe(200);
    const passkeyBrowser = (await signInUmaWithPasskey()).browser;
    expect((await passkeyBrowser.get("/v1/me")).status).toBe(200);
    const jwt = (await passkeyBrowser.get("/api/auth/token")).json.token;
    expect(jwt).toBeTruthy();

    const calls: string[] = [];
    h.deps.lifecycle.on("deactivated", {
      name: "test-hook",
      run: async (id) => void calls.push(id),
    });
    const res = await installAdmin.post(`/v1/install/users/${ids.uma}/deactivate`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ deactivated: true, incompleteSteps: [] });
    expect(calls).toEqual([ids.uma]);

    expect((await passkeyBrowser.get("/v1/me")).status).toBe(401);
    expect((await passkeyBrowser.get("/v1/team")).status).toBe(401);
    expect((await passkeyBrowser.get("/api/auth/token")).status).toBe(401);
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`,
      [ids.uma],
    );
    expect(rows[0]).toEqual({ n: 0 });

    // Password + TOTP: the password step reveals nothing new; the session is refused.
    const totp = await signInUmaWithTotp();
    expect(totp.status).toBe(403);
    // Passkey.
    const passkey = await signInUmaWithPasskey();
    expect(passkey.status).toBe(403);
    expect((await passkey.browser.get("/v1/me")).status).toBe(401);
    const after = await h.admin.query(
      `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`,
      [ids.uma],
    );
    expect(after.rows[0]).toEqual({ n: 0 });
  });

  it("sends no password-reset email to a deactivated account", async () => {
    await h.admin.query(`DELETE FROM rate_limits`);
    const before = h.mailer.to("uma@life.test").length;
    expect((await requestReset("uma@life.test")).status).toBe(200);
    await h.mailer.settle();
    expect(h.mailer.to("uma@life.test").length).toBe(before);
  });

  it("keeps memberships (inert) and counts only active team admins", async () => {
    const roster = await h.admin.query(
      `SELECT user_id, role FROM team_members WHERE team_id = $1 ORDER BY role`,
      [team],
    );
    expect(roster.rows).toEqual(
      expect.arrayContaining([
        { user_id: ids.uma, role: "team_admin" },
        { user_id: ids.tess, role: "team_admin" },
      ]),
    );
    const tess = await h.signIn("tess@life.test");
    await tess.put("/v1/me/teams/active", { teamId: team });
    tess.team = team;
    // Uma is deactivated: Tess is the only active admin and can't step down.
    expect((await tess.patch(`/v1/team/members/${ids.tess}`, { role: "member" })).json.code).toBe(
      "last_team_admin",
    );
  });

  it("lists users with their status for install admins", async () => {
    const res = await installAdmin.get("/v1/install/users");
    const uma = res.json.users.find((u: { id: string }) => u.id === ids.uma);
    expect(uma).toMatchObject({ email: "uma@life.test", installRole: "user" });
    expect(uma.deactivatedAt).toEqual(expect.any(String));
    expect(res.json.users.find((u: { id: string }) => u.id === ids.owner)).toMatchObject({
      installRole: "owner",
      deactivatedAt: null,
    });
  });

  it("reports teams left without an active team admin", async () => {
    const tess = await h.signIn("tess@life.test");
    const res = await owner.post(`/v1/install/users/${ids.tess}/deactivate`);
    expect(res.json.teamsWithoutActiveAdmin).toEqual([{ id: team, slug: "ops", name: "Ops" }]);
    expect((await tess.get("/v1/me")).status).toBe(401);
  });

  it("reactivation restores sign-in and team access", async () => {
    expect((await installAdmin.post(`/v1/install/users/${ids.uma}/reactivate`)).status).toBe(200);
    expect((await installAdmin.post(`/v1/install/users/${ids.tess}/reactivate`)).status).toBe(200);
    const totp = await signInUmaWithTotp();
    expect(totp.status).toBe(200);
    const { browser, status } = await signInUmaWithPasskey();
    expect(status).toBe(200);
    expect((await browser.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    expect((await browser.get("/v1/team")).json.role).toBe("team_admin");
  });

  it("reports a failing downstream step without undoing the deactivation", async () => {
    h.deps.lifecycle.on("deactivated", {
      name: "stop-sandboxes",
      run: async () => {
        throw new Error("cluster unreachable");
      },
    });
    const res = await owner.post(`/v1/install/users/${ids.admin2}/deactivate`);
    expect(res.json.incompleteSteps).toEqual(["stop-sandboxes"]);
    // Password-only account: the right password still gets no session.
    const signIn = await h
      .browser()
      .post("/api/auth/sign-in/email", { email: "admin2@life.test", password: PASSWORD });
    expect(signIn).toMatchObject({ status: 403, json: { code: "ACCOUNT_DEACTIVATED" } });
  });
});
