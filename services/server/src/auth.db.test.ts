import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "./app.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { SoftwareAuthenticator } from "./testing/webauthn.js";
import { totpFromUri } from "./testing/totp.js";

const PUBLIC_URL = "http://kobe.test";
const OWNER = { email: "owner@kobe.test", name: "Owner", password: "correct horse battery staple" };

let deps: ServerDeps;
let app: ReturnType<typeof createApp>;
const admin = new pg.Pool({ connectionString: inject("adminUrl") });

/** Minimal browser: keeps cookies and sends the Origin header Better Auth's CSRF check expects. */
class Browser {
  private readonly cookies = new Map<string, string>();

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { origin: PUBLIC_URL };
    if (this.cookies.size > 0)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(`${PUBLIC_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [name, ...rest] = (pair ?? "").split("=");
      const value = rest.join("=");
      if (!name) continue;
      if (value === "" || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, json: text ? safeJson(text) : null };
  }

  get = (path: string) => this.request("GET", path);
  post = (path: string, body: unknown = {}) => this.request("POST", path, body);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The Owner's otpauth:// URI, captured at enrollment (what an authenticator app would hold). */
let ownerTotpUri = "";

/** Password + TOTP sign-in for the Owner once 2FA is enrolled. */
async function signInOwner(b: Browser = new Browser()): Promise<Browser> {
  const first = await b.post("/api/auth/sign-in/email", {
    email: OWNER.email,
    password: OWNER.password,
  });
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  const second = await b.post("/api/auth/two-factor/verify-totp", {
    code: totpFromUri(ownerTotpUri),
  });
  expect(second.status, JSON.stringify(second.json)).toBe(200);
  return b;
}

async function signedIn(email: string, password: string): Promise<Browser> {
  const b = new Browser();
  const res = await b.post("/api/auth/sign-in/email", { email, password });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return b;
}

beforeAll(() => {
  deps = createServerDeps({
    databaseUrl: inject("appUrl"),
    publicUrl: PUBLIC_URL,
    authSecret: "s".repeat(48),
  });
  app = createApp(deps);
});

afterAll(async () => {
  await deps.close();
  await admin.end();
});

describe("first-run setup (ac-1)", () => {
  it("is required while no users exist", async () => {
    expect(await new Browser().get("/v1/setup")).toEqual({ status: 200, json: { required: true } });
  });

  it("rejects a weak password", async () => {
    const res = await new Browser().post("/v1/setup", { ...OWNER, password: "short" });
    expect(res.status).toBe(400);
  });

  it("creates exactly one Owner even under concurrent requests, then disables itself", async () => {
    const results = await Promise.all([1, 2, 3].map(() => new Browser().post("/v1/setup", OWNER)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await new Browser().get("/v1/setup")).toEqual({
      status: 200,
      json: { required: false },
    });
    expect(
      (await new Browser().post("/v1/setup", { ...OWNER, email: "late@kobe.test" })).status,
    ).toBe(409);
    const { rows } = await admin.query(
      `SELECT u.email, r.role FROM install_roles r JOIN users u ON u.id = r.user_id`,
    );
    expect(rows).toEqual([{ email: OWNER.email, role: "owner" }]);
  });

  it("lets the Owner sign in with email and password", async () => {
    const b = await signedIn(OWNER.email, OWNER.password);
    const me = await b.get("/v1/me");
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ user: { email: OWNER.email }, installRole: "owner" });
  });

  it("does not allow self sign-up (invite-only)", async () => {
    const res = await new Browser().post("/api/auth/sign-up/email", {
      email: "stranger@kobe.test",
      name: "Stranger",
      password: "a perfectly long password",
    });
    expect(res.status).not.toBe(200);
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM users WHERE email = 'stranger@kobe.test'`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe("TOTP 2FA (ac-2)", () => {
  it("enrolls with a TOTP code", async () => {
    const b = await signedIn(OWNER.email, OWNER.password);
    const enable = await b.post("/api/auth/two-factor/enable", { password: OWNER.password });
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    ownerTotpUri = enable.json.totpURI;
    expect(ownerTotpUri).toMatch(/^otpauth:\/\/totp\//);
    const verify = await b.post("/api/auth/two-factor/verify-totp", {
      code: totpFromUri(ownerTotpUri),
    });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    expect((await b.get("/v1/me")).json.user.twoFactorEnabled).toBe(true);
  });

  it("requires the TOTP code to complete a password sign-in", async () => {
    const b = new Browser();
    const first = await b.post("/api/auth/sign-in/email", {
      email: OWNER.email,
      password: OWNER.password,
    });
    expect(first.json).toMatchObject({ twoFactorRedirect: true });
    expect((await b.get("/v1/me")).status).toBe(401);
    const wrong = await b.post("/api/auth/two-factor/verify-totp", { code: "000000" });
    expect(wrong.status).not.toBe(200);
    const ok = await b.post("/api/auth/two-factor/verify-totp", {
      code: totpFromUri(ownerTotpUri),
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await b.get("/v1/me")).status).toBe(200);
  });
});

describe("passkeys (ac-2)", () => {
  const authenticator = new SoftwareAuthenticator("kobe.test", PUBLIC_URL);

  it("registers a passkey for a signed-in user", async () => {
    const b = await signInOwner();
    const options = await b.get("/api/auth/passkey/generate-register-options");
    expect(options.status, JSON.stringify(options.json)).toBe(200);
    const verify = await b.post("/api/auth/passkey/verify-registration", {
      response: authenticator.register(options.json),
      name: "test key",
    });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    const list = await b.get("/api/auth/passkey/list-user-passkeys");
    expect(list.json).toHaveLength(1);
  });

  it("signs in with the passkey alone", async () => {
    const b = new Browser();
    const options = await b.get("/api/auth/passkey/generate-authenticate-options");
    expect(options.status, JSON.stringify(options.json)).toBe(200);
    const verify = await b.post("/api/auth/passkey/verify-authentication", {
      response: authenticator.authenticate(options.json),
    });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    expect((await b.get("/v1/me")).json).toMatchObject({ user: { email: OWNER.email } });
  });

  it("rejects an assertion from an unregistered authenticator", async () => {
    const b = new Browser();
    const options = await b.get("/api/auth/passkey/generate-authenticate-options");
    const stranger = new SoftwareAuthenticator("kobe.test", PUBLIC_URL);
    const verify = await b.post("/api/auth/passkey/verify-authentication", {
      response: stranger.authenticate(options.json),
    });
    expect(verify.status).not.toBe(200);
    expect((await b.get("/v1/me")).status).toBe(401);
  });
});

describe("required 2FA (ac-2)", () => {
  const MEMBER = { email: "member@kobe.test", name: "Member", password: "another long password!" };

  beforeAll(async () => {
    await deps.createUserWithPassword(MEMBER);
  });

  it("only install admins can require 2FA", async () => {
    const member = await signedIn(MEMBER.email, MEMBER.password);
    expect(
      (await member.request("PUT", "/v1/install/settings", { requireTwoFactor: true })).status,
    ).toBe(403);
  });

  it("forces users without 2FA to enroll before using the API", async () => {
    const owner = await signInOwner();
    expect(
      (await owner.request("PUT", "/v1/install/settings", { requireTwoFactor: true })).status,
    ).toBe(200);

    const member = await signedIn(MEMBER.email, MEMBER.password);
    const blocked = await member.get("/v1/me");
    expect(blocked.status).toBe(403);
    expect(blocked.json).toMatchObject({ code: "two_factor_enrollment_required" });

    const enable = await member.post("/api/auth/two-factor/enable", { password: MEMBER.password });
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    const verify = await member.post("/api/auth/two-factor/verify-totp", {
      code: totpFromUri(enable.json.totpURI),
    });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    expect((await member.get("/v1/me")).status).toBe(200);
  });
});

describe("server-side session revocation (ac-3)", () => {
  it("revokes a single session immediately", async () => {
    const a = await signInOwner();
    const b = await signInOwner();
    expect((await b.get("/v1/me")).status).toBe(200);
    const bToken = (await b.get("/api/auth/get-session")).json.session.token;
    const listed = (await a.get("/api/auth/list-sessions")).json.map(
      (s: { token: string }) => s.token,
    );
    expect(listed).toContain(bToken);
    expect((await a.post("/api/auth/revoke-session", { token: bToken })).status).toBe(200);
    expect((await b.get("/v1/me")).status).toBe(401);
    expect((await a.get("/v1/me")).status).toBe(200);
  });

  it("revokes every session of a user from the server (deactivation path)", async () => {
    const a = await signInOwner();
    const me = await a.get("/v1/me");
    expect(me.status).toBe(200);
    await deps.revokeAllSessions(me.json.user.id);
    expect((await a.get("/v1/me")).status).toBe(401);
  });
});
