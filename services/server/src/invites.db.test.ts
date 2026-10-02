import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, PASSWORD, type Harness } from "./testing/harness.js";
import { totpFromUri } from "./testing/totp.js";

// KOBE-13 ac-1 (install invitations) and ac-2 (team invitations): invite-only onboarding (D7, U1).
let h: Harness;
const ids = { owner: "", admin: "", alice: "" };
let owner: TestBrowser;
let installAdmin: TestBrowser;
let alice: TestBrowser;
let finance = "";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const INVALID = "INVALID_INVITATION";

beforeAll(async () => {
  h = await openHarness();
  ids.owner = await h.createUser("owner@inv.test", "owner");
  ids.admin = await h.createUser("admin@inv.test", "admin");
  ids.alice = await h.createUser("alice@inv.test");
  [owner, installAdmin, alice] = await Promise.all([
    h.signIn("owner@inv.test"),
    h.signIn("admin@inv.test"),
    h.signIn("alice@inv.test"),
  ]);
  const team = await owner.post("/v1/install/teams", {
    slug: "finance",
    name: "Finance",
    adminUserId: ids.alice,
  });
  finance = team.json.team.id;
  await alice.put("/v1/me/teams/active", { teamId: finance });
  alice.team = finance;
});

afterAll(async () => {
  await h?.close();
});

async function invite(email: string, by: TestBrowser = installAdmin): Promise<string> {
  const res = await by.post("/v1/install/invites", { email });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return h.mailer.lastToken(email);
}

async function accept(token: unknown, b: TestBrowser = h.browser(), password = PASSWORD) {
  return b.post("/api/auth/invitation/accept", { token, name: "New Person", password });
}

describe("install invitations (ac-1)", () => {
  it("are for install admins only", async () => {
    expect((await alice.post("/v1/install/invites", { email: "x@inv.test" })).status).toBe(403);
    expect((await alice.get("/v1/install/invites")).status).toBe(403);
    expect(h.mailer.to("x@inv.test")).toEqual([]);
  });

  it("mail a single-use link whose token is only stored hashed", async () => {
    const res = await installAdmin.post("/v1/install/invites", { email: "Nina@Inv.Test" });
    expect(res).toMatchObject({
      status: 201,
      json: { invitation: { email: "nina@inv.test" }, emailSent: true },
    });
    expect(JSON.stringify(res.json)).not.toMatch(/token/i);
    const [mail] = h.mailer.to("nina@inv.test");
    expect(mail?.subject).toBe("admin invited you to Kobe");
    expect(mail?.text).toMatch(/http:\/\/kobe\.test\/invite#token=[A-Za-z0-9_-]{43}\n/);
    const token = h.mailer.lastToken("nina@inv.test");
    const { rows } = await h.admin.query(`SELECT * FROM invitations WHERE email = 'nina@inv.test'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    const ttl = rows[0].expires_at.getTime() - rows[0].created_at.getTime();
    expect(Math.abs(ttl - 72 * 3600 * 1000)).toBeLessThan(1000);
  });

  it("show the invited address to the link holder, then create the account and sign in", async () => {
    const token = h.mailer.lastToken("nina@inv.test");
    const b = h.browser();
    expect(await b.post("/api/auth/invitation/lookup", { token })).toMatchObject({
      status: 200,
      json: { email: "nina@inv.test" },
    });
    const res = await accept(token, b);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.user).toMatchObject({ email: "nina@inv.test", name: "New Person" });
    expect((await b.get("/v1/me")).json).toMatchObject({
      user: { email: "nina@inv.test" },
      installRole: null,
    });
    // U1: only teams the person was invited to (none yet).
    expect((await b.get("/v1/me/teams")).json.teams).toEqual([]);
    const { rows } = await h.admin.query(
      `SELECT u.email_verified, i.accepted_user_id = u.id AS linked FROM users u
       JOIN invitations i ON i.email = u.email WHERE u.email = 'nina@inv.test'`,
    );
    expect(rows).toEqual([{ email_verified: true, linked: true }]);
    await h.signIn("nina@inv.test");
  });

  it("can't be used twice", async () => {
    const token = h.mailer.lastToken("nina@inv.test");
    const again = await accept(token);
    expect(again).toMatchObject({ status: 400, json: { code: INVALID } });
    expect((await h.browser().post("/api/auth/invitation/lookup", { token })).status).toBe(400);
  });

  it("let exactly one of several concurrent acceptances through", async () => {
    const token = await invite("race@inv.test");
    const results = await Promise.all([1, 2, 3].map(() => accept(token)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM users WHERE email = 'race@inv.test'`,
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it("answer every bad token the same way (unknown, malformed, expired, revoked)", async () => {
    const expired = await invite("late@inv.test");
    await h.admin.query(
      `UPDATE invitations SET expires_at = now() - interval '1 second' WHERE email = 'late@inv.test'`,
    );
    const revokedToken = await invite("gone@inv.test");
    const list = await installAdmin.get("/v1/install/invites");
    const gone = list.json.invitations.find((i: { email: string }) => i.email === "gone@inv.test");
    expect(list.json.invitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: "late@inv.test", status: "expired" }),
        expect.objectContaining({ email: "gone@inv.test", status: "pending" }),
      ]),
    );
    expect((await installAdmin.delete(`/v1/install/invites/${gone.id}`)).status).toBe(204);
    expect((await installAdmin.delete(`/v1/install/invites/${gone.id}`)).status).toBe(404);

    const bodies = [];
    for (const token of [
      "A".repeat(43),
      "short",
      expired,
      revokedToken,
      `${expired.slice(0, 42)}x`,
    ]) {
      const res = await accept(token);
      expect(res.status, String(token)).toBe(400);
      bodies.push(res.json.code ?? res.json);
    }
    expect(new Set(bodies)).toEqual(new Set([INVALID]));
    expect((await accept(12345)).status).toBe(400);
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM users WHERE email IN ('late@inv.test', 'gone@inv.test')`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it("rotate the token on resend (the old link stops working)", async () => {
    const old = await invite("resend@inv.test");
    const id = (await installAdmin.get("/v1/install/invites")).json.invitations.find(
      (i: { email: string }) => i.email === "resend@inv.test",
    ).id;
    expect((await installAdmin.post(`/v1/install/invites/${id}/resend`)).status).toBe(200);
    const fresh = h.mailer.lastToken("resend@inv.test");
    expect(fresh).not.toBe(old);
    expect((await accept(old)).json.code).toBe(INVALID);
    expect((await accept(fresh)).status).toBe(200);
    // Re-inviting the same open address re-issues too (one open invitation per address).
    const first = await invite("twice@inv.test");
    const second = await invite("twice@inv.test");
    expect((await accept(first)).json.code).toBe(INVALID);
    expect((await accept(second)).status).toBe(200);
  });

  it("refuse addresses that already have an account", async () => {
    expect(
      await installAdmin.post("/v1/install/invites", { email: "ALICE@inv.test" }),
    ).toMatchObject({ status: 409, json: { code: "user_exists" } });
  });

  it("enforce the password policy", async () => {
    const token = await invite("weak@inv.test");
    expect((await accept(token, h.browser(), "short")).status).toBe(400);
    expect((await accept(token, h.browser(), "x".repeat(129))).status).toBe(400);
    expect((await accept(token)).status).toBe(200);
  });

  it("report a failed delivery and let the admin resend", async () => {
    h.mailer.failNext = new Error("SMTP down");
    const res = await installAdmin.post("/v1/install/invites", { email: "bounce@inv.test" });
    expect(res).toMatchObject({ status: 201, json: { emailSent: false } });
    const resent = await installAdmin.post(`/v1/install/invites/${res.json.invitation.id}/resend`);
    expect(resent.json.emailSent).toBe(true);
    expect((await accept(h.mailer.lastToken("bounce@inv.test"))).status).toBe(200);
  });

  it("reject acceptance from another origin", async () => {
    const token = await invite("csrf@inv.test");
    const res = await h
      .browser()
      .request(
        "POST",
        "/api/auth/invitation/accept",
        { token, name: "X", password: PASSWORD },
        { origin: "https://evil.example" },
      );
    expect(res.status).toBe(403);
    expect((await accept(token)).status).toBe(200);
  });

  it("rate-limit acceptance attempts per client IP", async () => {
    const ip = { "x-forwarded-for": "198.51.100.250" };
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await h
        .browser()
        .request(
          "POST",
          "/api/auth/invitation/accept",
          { token: "B".repeat(43), name: "X", password: PASSWORD },
          ip,
        );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses[5]).toBe(429);
  });

  it("make the new user enroll 2FA before using the API when the install requires it", async () => {
    const token = await invite("strict@inv.test");
    await owner.put("/v1/install/settings", { requireTwoFactor: true });
    try {
      const b = h.browser();
      expect((await accept(token, b)).status).toBe(200);
      expect((await b.get("/v1/me")).json.code).toBe("two_factor_enrollment_required");
      const enable = await b.post("/api/auth/two-factor/enable", { password: PASSWORD });
      const code = totpFromUri(enable.json.totpURI);
      expect((await b.post("/api/auth/two-factor/verify-totp", { code })).status).toBe(200);
      expect((await b.get("/v1/me")).status).toBe(200);
    } finally {
      // The Owner is not enrolled; turning the requirement off needs a fresh owner session.
      await h.admin.query(`UPDATE install_settings SET value = 'false' WHERE key = 'require_2fa'`);
    }
  });
});

describe("team invitations (ac-2)", () => {
  it("answer the same whether or not the address belongs to a Kobe user", async () => {
    await h.createUser("bob@inv.test");
    const known = await alice.post("/v1/team/invites", { email: "bob@inv.test", role: "member" });
    const unknown = await alice.post("/v1/team/invites", {
      email: "stranger@inv.test",
      role: "member",
    });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(Object.keys(known.json.invitation).sort()).toEqual(
      Object.keys(unknown.json.invitation).sort(),
    );
    expect(Object.keys(known.json)).toEqual(Object.keys(unknown.json));
    await h.mailer.settle();
    // Existing users hear about it; nobody mails strangers on a team admin's word.
    expect(h.mailer.to("bob@inv.test").at(-1)?.subject).toBe(
      "alice invited you to the Finance team on Kobe",
    );
    expect(h.mailer.to("stranger@inv.test")).toEqual([]);
  });

  it("never add anyone without their acceptance", async () => {
    const roster = await alice.get("/v1/team/members");
    expect(roster.json.members.map((m: { email: string }) => m.email)).toEqual(["alice@inv.test"]);
    const pending = await alice.get("/v1/team/invites");
    expect(pending.json.invitations.map((i: { email: string }) => i.email).sort()).toEqual([
      "bob@inv.test",
      "stranger@inv.test",
    ]);
  });

  it("are visible only to the invited person, who can accept with the invited role", async () => {
    const bob = await h.signIn("bob@inv.test");
    expect((await bob.get("/v1/me/invites")).json.invitations).toEqual([
      {
        teamId: finance,
        teamSlug: "finance",
        teamName: "Finance",
        role: "member",
        invitedByName: "alice",
        expiresAt: expect.any(String),
      },
    ]);
    expect((await installAdmin.get("/v1/me/invites")).json.invitations).toEqual([]);
    // Nobody else can accept Bob's invitation.
    expect((await installAdmin.post(`/v1/me/invites/${finance}/accept`)).status).toBe(404);
    expect((await bob.post(`/v1/me/invites/${randomUUID()}/accept`)).status).toBe(404);
    expect(await bob.post(`/v1/me/invites/${finance}/accept`)).toMatchObject({
      status: 200,
      json: { teamId: finance, role: "member" },
    });
    expect((await bob.get("/v1/me/teams")).json.teams).toEqual([
      expect.objectContaining({ id: finance, role: "member" }),
    ]);
    expect((await bob.get("/v1/me/invites")).json.invitations).toEqual([]);
    expect((await bob.post(`/v1/me/invites/${finance}/accept`)).status).toBe(404);
  });

  it("can be declined, revoked, and expire", async () => {
    await h.createUser("carol@inv.test");
    const carol = await h.signIn("carol@inv.test");
    await alice.post("/v1/team/invites", { email: "carol@inv.test", role: "builder" });
    expect((await carol.post(`/v1/me/invites/${finance}/decline`)).status).toBe(204);
    expect((await carol.post(`/v1/me/invites/${finance}/accept`)).status).toBe(404);

    const again = await alice.post("/v1/team/invites", { email: "carol@inv.test", role: "member" });
    expect((await alice.delete(`/v1/team/invites/${again.json.invitation.id}`)).status).toBe(204);
    expect((await carol.post(`/v1/me/invites/${finance}/accept`)).status).toBe(404);

    await alice.post("/v1/team/invites", { email: "carol@inv.test", role: "member" });
    await h.admin.query(
      `UPDATE team_invitations SET expires_at = now() - interval '1 second' WHERE email = 'carol@inv.test'`,
    );
    expect((await carol.get("/v1/me/invites")).json.invitations).toEqual([]);
    expect((await carol.post(`/v1/me/invites/${finance}/accept`)).status).toBe(404);
    expect((await carol.get("/v1/me/teams")).json.teams).toEqual([]);
  });

  it("are only for the team's admins, never install admins (D8)", async () => {
    const bob = await h.signIn("bob@inv.test");
    await bob.put("/v1/me/teams/active", { teamId: finance });
    bob.team = finance;
    expect(
      (await bob.post("/v1/team/invites", { email: "z@inv.test", role: "member" })).status,
    ).toBe(403);
    expect((await bob.get("/v1/team/invites")).status).toBe(403);
    // An install admin who is not a member has no active team to invite into.
    expect(
      (
        await installAdmin.request(
          "POST",
          "/v1/team/invites",
          { email: "z@inv.test", role: "member" },
          { "x-kobe-team": finance },
        )
      ).status,
    ).toBe(409);
  });

  it("carry a brand-new person from the install invitation into their team (U1)", async () => {
    // The team admin invites the address first; the install admin brings the person in.
    await alice.post("/v1/team/invites", { email: "newbie@inv.test", role: "builder" });
    const b = h.browser();
    expect((await accept(await invite("newbie@inv.test"), b)).status).toBe(200);
    expect((await b.get("/v1/me/invites")).json.invitations).toEqual([
      expect.objectContaining({ teamId: finance, role: "builder" }),
    ]);
    expect((await b.post(`/v1/me/invites/${finance}/accept`)).status).toBe(200);
    expect((await b.get("/v1/me/teams")).json.teams).toEqual([
      { id: finance, slug: "finance", name: "Finance", role: "builder" },
    ]);
  });

  it("match on an address the user can't change (Better Auth change-email stays off)", async () => {
    const bob = await h.signIn("bob@inv.test");
    const res = await bob.post("/api/auth/change-email", { newEmail: "stranger@inv.test" });
    expect(res.status).not.toBe(200);
    expect((await bob.get("/v1/me")).json.user.email).toBe("bob@inv.test");
  });

  it("store team invitations behind team RLS", async () => {
    const { rows } = await h.admin.query(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
       WHERE relname = 'team_invitations'`,
    );
    expect(rows).toEqual([{ rls: true, force: true }]);
  });
});
