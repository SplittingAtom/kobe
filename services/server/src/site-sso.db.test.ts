import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnvelope, type Envelope } from "@kobe/db";
import { createApp } from "./app.js";
import { logger } from "./logger.js";
import { revealClientSecret, seedHelmProviders } from "./sso/providers.js";
import { loadSsoSettings, type SsoSettings } from "./sso/settings.js";
import { FakeIdp, resolver } from "./sso/testing.js";
import { TestBrowser } from "./testing/browser.js";
import { openHarness, PUBLIC_URL, type Harness } from "./testing/harness.js";

/**
 * Single sign-on provider configuration (KOBE-626, spec sso-oidc-scim §4): CRUD for
 * `site.users.manage`, discovery on save, the client secret sealed and never returned, Helm
 * providers read-only, and the `auth.sso.enabled` kill switch.
 */
const BASE = "/v1/site/sso/providers";
const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "99999999-2222-4333-8444-555555555555";
const ENTRA = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const KC = "https://kc.example.com/realms/kobe";
const SECRET = "Cl1ent~Secret.Value-0123456789abcdef";
const SECRET2 = "Second~Secret.Value-9876543210fedcba";
const HELM_SECRET = "Helm~Secret.Value-from-the-k8s-Secret";

const idp = new FakeIdp()
  .discovery(ENTRA, { code_challenge_methods_supported: undefined })
  .discovery(`https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`)
  .discovery(KC)
  .discovery("https://mismatch.example.com", { issuer: "https://evil.example.com" });

const helmEnv = (providers: unknown[], enabled = "true"): SsoSettings =>
  loadSsoSettings({
    KOBE_SSO_ENABLED: enabled,
    KOBE_SSO_PROVIDERS: JSON.stringify(providers),
    KOBE_SSO_CLIENT_SECRET_CORP: HELM_SECRET,
  });
const HELM_PROVIDER = {
  slug: "corp",
  displayName: "Corp Entra",
  kind: "entra",
  tenantId: TENANT,
  clientId: "corp-app",
};

const logged: string[] = [];
let h: Harness;
let admin: TestBrowser;
let member: TestBrowser;
let adminId = "";

beforeAll(async () => {
  for (const level of ["info", "warn", "error", "debug"] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => void)(...args);
    }) as never);
  }
  h = await openHarness({
    envelope: loadEnvelope({ KOBE_ENVELOPE_KEY: "s".repeat(48) }) as Envelope,
    sso: {
      settings: helmEnv([HELM_PROVIDER]),
      net: { resolve: resolver({ "private.example.com": ["10.9.8.7"] }) },
      request: idp.request,
    },
  });
  adminId = await h.createUser("root@sso.test", "admin");
  await h.createUser("member@sso.test");
  admin = await h.signIn("root@sso.test");
  member = await h.signIn("member@sso.test");
});
afterAll(async () => {
  vi.restoreAllMocks();
  await h?.close();
});

const entraBody = (over: Record<string, unknown> = {}) => ({
  kind: "entra",
  slug: "contoso",
  displayName: "Contoso",
  tenantId: TENANT,
  clientId: "11111111-aaaa-4bbb-8ccc-222222222222",
  clientSecret: SECRET,
  ...over,
});

async function auditOf(providerId: string) {
  const { rows } = await h.admin.query<{ action: string; target: unknown; actor_kind: string }>(
    `SELECT action, target, actor_kind FROM audit_log WHERE target ->> 'providerId' = $1 ORDER BY seq`,
    [providerId],
  );
  return rows;
}

async function everyAuditText(): Promise<string> {
  const { rows } = await h.admin.query<{ t: string }>(
    `SELECT to_jsonb(a)::text AS t FROM audit_log a`,
  );
  return rows.map((r) => r.t).join("\n");
}

describe("who may configure providers", () => {
  it("is site.users.manage only", async () => {
    expect((await member.get(BASE)).status).toBe(403);
    expect((await member.post(BASE, entraBody())).status).toBe(403);
    expect((await h.browser().get(BASE)).status).toBe(401);
    expect((await admin.get(BASE)).status).toBe(200);
  });

  it("tells site admins the console page is on (/v1/me siteFeatures)", async () => {
    expect((await admin.get("/v1/me")).json.siteFeatures).toEqual(["sso"]);
    expect((await member.get("/v1/me")).json.siteFeatures).toBeUndefined();
  });
});

describe("tenant pinning and discovery on save", () => {
  it.each(["common", "organizations", "consumers"])(
    "refuses the Entra authority %s (ac-1)",
    async (tenantId) => {
      const res = await admin.post(BASE, entraBody({ slug: `t-${tenantId}`, tenantId }));
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({
        code: "discovery_failed",
        discovery: { ok: false, failure: "multi_tenant_issuer" },
      });
    },
  );

  it("refuses a generic issuer naming common (ac-1)", async () => {
    const res = await admin.post(BASE, {
      ...entraBody({ slug: "generic-common" }),
      kind: "oidc",
      tenantId: undefined,
      issuer: "https://login.microsoftonline.com/common/v2.0",
    });
    expect(res.status).toBe(422);
    expect(res.json.discovery.failure).toBe("multi_tenant_issuer");
  });

  it("refuses a discovery document whose issuer differs (ac-2)", async () => {
    const res = await admin.post(BASE, {
      ...entraBody({ slug: "mismatch" }),
      kind: "oidc",
      tenantId: undefined,
      issuer: "https://mismatch.example.com",
    });
    expect(res.status).toBe(422);
    expect(res.json.discovery).toMatchObject({ ok: false, failure: "issuer_mismatch" });
  });

  it("refuses an issuer on a private address (ac-6)", async () => {
    const res = await admin.post(BASE, {
      ...entraBody({ slug: "private" }),
      kind: "oidc",
      tenantId: undefined,
      issuer: "https://private.example.com",
    });
    expect(res.status).toBe(422);
    expect(res.json.discovery.failure).toBe("address_not_allowed");
    const { rows } = await h.admin.query(`SELECT 1 FROM sso_providers WHERE slug = 'private'`);
    expect(rows).toEqual([]);
  });

  it("tests an unsaved form and reports each check", async () => {
    const res = await admin.post(`${BASE}/test`, { kind: "entra", tenantId: TENANT });
    expect(res.status).toBe(200);
    expect(res.json.discovery).toMatchObject({ ok: true, issuer: ENTRA });
    expect(res.json.discovery.checks).toHaveLength(7);
    const bad = await admin.post(`${BASE}/test`, { kind: "entra", tenantId: "common" });
    expect(bad.json.discovery).toMatchObject({ ok: false, failure: "multi_tenant_issuer" });
  });
});

describe("console providers and the client secret (ac-3)", () => {
  let id = "";

  it("creates a provider, seals the secret and never returns it", async () => {
    const res = await admin.post(BASE, entraBody());
    expect(res.status, res.text).toBe(201);
    id = res.json.provider.id;
    expect(res.json.provider).toMatchObject({
      slug: "contoso",
      kind: "entra",
      issuer: ENTRA,
      tenantId: TENANT,
      subjectClaim: "oid",
      accessClaim: "roles",
      mfaRule: { acrs_any: ["c1"] },
      enabled: false,
      managedBy: "console",
      clientSecret: "set",
      redirectUri: `${PUBLIC_URL}/api/auth/sso/callback/contoso`,
      linkedIdentities: 0,
    });
    expect(res.text).not.toContain(SECRET);
    const { rows } = await h.admin.query<{ sealed: string; kid: string }>(
      `SELECT client_secret_sealed AS sealed, client_secret_key_id AS kid FROM sso_providers WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.sealed).toMatch(/^e1\./);
    expect(rows[0]?.sealed).not.toContain(SECRET);
    expect(await revealClientSecret(h.deps.sso.providers, id)).toBe(SECRET);
    for (const path of [BASE, `${BASE}/${id}`]) {
      const read = await admin.get(path);
      expect(read.status).toBe(200);
      expect(read.text).not.toContain(SECRET);
      expect(read.text).not.toContain(rows[0]?.sealed ?? "x");
    }
    expect(await auditOf(id)).toEqual([
      {
        action: "identity.sso.provider.created",
        actor_kind: "user",
        target: { providerId: id, slug: "contoso", kind: "entra" },
      },
    ]);
  });

  it("refuses a second provider with the same slug", async () => {
    const res = await admin.post(BASE, entraBody());
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("slug_taken");
  });

  it("keeps the secret on an edit without one and replaces it on request", async () => {
    const kept = await admin.patch(`${BASE}/${id}`, { displayName: "Contoso Ltd" });
    expect(kept.status).toBe(200);
    expect(kept.json.provider.displayName).toBe("Contoso Ltd");
    expect(await revealClientSecret(h.deps.sso.providers, id)).toBe(SECRET);
    const replaced = await admin.patch(`${BASE}/${id}`, { clientSecret: SECRET2 });
    expect(replaced.status).toBe(200);
    expect(replaced.text).not.toContain(SECRET2);
    expect(replaced.json.provider.clientSecret).toBe("set");
    expect(await revealClientSecret(h.deps.sso.providers, id)).toBe(SECRET2);
  });

  it("discovers a new tenant before saving it and refuses common", async () => {
    const bad = await admin.patch(`${BASE}/${id}`, { tenantId: "organizations" });
    expect(bad.status).toBe(422);
    expect(bad.json.discovery.failure).toBe("multi_tenant_issuer");
    const moved = await admin.patch(`${BASE}/${id}`, { tenantId: OTHER_TENANT });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.json.provider).toMatchObject({
      tenantId: OTHER_TENANT,
      issuer: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`,
    });
    expect(moved.json.discovery.ok).toBe(true);
    const wrongField = await admin.patch(`${BASE}/${id}`, { issuer: KC });
    expect(wrongField.status).toBe(400);
  });

  it("enables and disables; disabling ends the provider's sessions", async () => {
    expect((await admin.patch(`${BASE}/${id}`, { enabled: true })).json.provider.enabled).toBe(
      true,
    );
    // An SSO session of someone else, and the admin's own local session (untouched).
    const userId = await h.createUser(`sso-${randomUUID()}@sso.test`);
    const sessionId = randomUUID();
    await h.admin.query(
      `INSERT INTO sessions (id, token, user_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`,
      [sessionId, `tok-${sessionId}`, userId],
    );
    await h.admin.query(
      `INSERT INTO session_sso_contexts (session_id, provider_id, mfa_satisfied) VALUES ($1, $2, true)`,
      [sessionId, id],
    );
    expect((await admin.patch(`${BASE}/${id}`, { enabled: false })).json.provider.enabled).toBe(
      false,
    );
    const { rows } = await h.admin.query(`SELECT 1 FROM sessions WHERE id = $1`, [sessionId]);
    expect(rows).toEqual([]);
    expect((await admin.get(BASE)).status).toBe(200);
    expect((await auditOf(id)).map((r) => r.action)).toEqual([
      "identity.sso.provider.created",
      "identity.sso.provider.updated",
      "identity.sso.provider.updated",
      "identity.sso.provider.updated",
      "identity.sso.provider.enabled",
      "identity.sso.provider.disabled",
    ]);
  });

  it("refuses to change the issuer, tenant or subject claim while identities are linked (finding 5)", async () => {
    const userId = await h.createUser(`locked-${randomUUID()}@sso.test`);
    await h.admin.query(
      `INSERT INTO sso_identities (provider_id, subject, user_id, linked_via) VALUES ($1, 'oid-locked', $2, 'jit')`,
      [id, userId],
    );
    try {
      const before = (await admin.get(`${BASE}/${id}`)).json.provider;
      for (const body of [{ tenantId: TENANT }, { subjectClaim: "sub" }]) {
        const res = await admin.patch(`${BASE}/${id}`, body);
        expect(res.status, JSON.stringify(body)).toBe(409);
        expect(res.json.code).toBe("identity_settings_locked");
      }
      const after = (await admin.get(`${BASE}/${id}`)).json.provider;
      expect(after).toMatchObject({
        tenantId: before.tenantId,
        issuer: before.issuer,
        subjectClaim: before.subjectClaim,
      });
      // Other fields, and the same values, still save.
      expect((await admin.patch(`${BASE}/${id}`, { displayName: "Contoso" })).status).toBe(200);
      expect(
        (await admin.patch(`${BASE}/${id}`, { tenantId: before.tenantId, subjectClaim: "oid" }))
          .status,
      ).toBe(200);
    } finally {
      await h.admin.query(`DELETE FROM sso_identities WHERE provider_id = $1`, [id]);
    }
  });

  it("refuses to delete while an identity is linked, then deletes", async () => {
    const userId = await h.createUser(`linked-${randomUUID()}@sso.test`);
    await h.admin.query(
      `INSERT INTO sso_identities (provider_id, subject, user_id, linked_via) VALUES ($1, 'oid-1', $2, 'jit')`,
      [id, userId],
    );
    const refused = await admin.delete(`${BASE}/${id}`);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("identities_linked");
    await h.admin.query(`DELETE FROM sso_identities WHERE provider_id = $1`, [id]);
    expect((await admin.delete(`${BASE}/${id}`)).status).toBe(204);
    expect((await admin.get(`${BASE}/${id}`)).status).toBe(404);
    expect((await auditOf(id)).at(-1)?.action).toBe("identity.sso.provider.deleted");
  });

  it("never wrote a secret into an audit row or a log line", async () => {
    const audit = await everyAuditText();
    for (const secret of [SECRET, SECRET2, HELM_SECRET]) {
      expect(audit).not.toContain(secret);
      expect(logged.join("\n")).not.toContain(secret);
    }
  });
});

describe("Helm providers (ac-4)", () => {
  let helmId = "";

  beforeAll(async () => {
    await seedHelmProviders(h.deps.database.db, h.deps.sso.settings);
    const { rows } = await h.admin.query<{ id: string }>(
      `SELECT id FROM sso_providers WHERE slug = 'corp'`,
    );
    helmId = rows[0]?.id ?? "";
  });

  it("is listed read-only with its secret held only in the Secret", async () => {
    const res = await admin.get(`${BASE}/${helmId}`);
    expect(res.json.provider).toMatchObject({
      slug: "corp",
      managedBy: "helm",
      clientSecret: "set",
      enabled: true,
      issuer: ENTRA,
    });
    expect(res.text).not.toContain(HELM_SECRET);
    const { rows } = await h.admin.query(
      `SELECT client_secret_sealed, client_secret_key_id FROM sso_providers WHERE id = $1`,
      [helmId],
    );
    expect(rows).toEqual([{ client_secret_sealed: null, client_secret_key_id: null }]);
    expect(await revealClientSecret(h.deps.sso.providers, helmId)).toBe(HELM_SECRET);
  });

  it("refuses edits, toggles and deletion from the console", async () => {
    for (const body of [{ displayName: "x" }, { enabled: false }, { clientSecret: SECRET }]) {
      const res = await admin.patch(`${BASE}/${helmId}`, body);
      expect(res.status).toBe(409);
      expect(res.json.code).toBe("managed_by_helm");
    }
    expect((await admin.delete(`${BASE}/${helmId}`)).json.code).toBe("managed_by_helm");
  });

  it("can still be tested", async () => {
    const res = await admin.post(`${BASE}/${helmId}/test`);
    expect(res.json.discovery).toMatchObject({ ok: true });
  });

  it("upserts idempotently, follows the values, and disables a dropped provider", async () => {
    const db = h.deps.database.db;
    const count = async () =>
      (await h.admin.query(`SELECT count(*)::int AS n FROM audit_log`)).rows[0].n as number;
    const before = await count();
    expect(await seedHelmProviders(db, helmEnv([HELM_PROVIDER]))).toMatchObject({
      created: [],
      updated: [],
    });
    expect(await count()).toBe(before);
    await seedHelmProviders(db, helmEnv([{ ...HELM_PROVIDER, displayName: "Corp 2" }]));
    expect((await admin.get(`${BASE}/${helmId}`)).json.provider.displayName).toBe("Corp 2");
    const retired = await seedHelmProviders(db, helmEnv([]));
    expect(retired.retired).toEqual(["corp"]);
    expect((await admin.get(`${BASE}/${helmId}`)).json.provider.enabled).toBe(false);
    expect((await auditOf(helmId)).map((r) => [r.action, r.actor_kind])).toEqual([
      ["identity.sso.provider.created", "system"],
      ["identity.sso.provider.enabled", "system"],
      ["identity.sso.provider.updated", "system"],
      ["identity.sso.provider.disabled", "system"],
    ]);
  });

  it("keeps a linked Helm provider's tenant and subject claim (finding 5)", async () => {
    const db = h.deps.database.db;
    await seedHelmProviders(db, helmEnv([HELM_PROVIDER]));
    const userId = await h.createUser(`helm-linked-${randomUUID()}@sso.test`);
    await h.admin.query(
      `INSERT INTO sso_identities (provider_id, subject, user_id, linked_via) VALUES ($1, 'oid-helm', $2, 'jit')`,
      [helmId, userId],
    );
    try {
      const seeded = await seedHelmProviders(
        db,
        helmEnv([{ ...HELM_PROVIDER, tenantId: OTHER_TENANT, displayName: "Moved" }]),
      );
      expect(seeded.locked).toEqual(["corp"]);
      expect((await admin.get(`${BASE}/${helmId}`)).json.provider).toMatchObject({
        tenantId: TENANT,
        issuer: ENTRA,
      });
    } finally {
      await h.admin.query(`DELETE FROM sso_identities WHERE provider_id = $1`, [helmId]);
    }
  });

  it("never overwrites a console provider of the same slug", async () => {
    const res = await admin.post(BASE, entraBody({ slug: "taken" }));
    expect(res.status).toBe(201);
    const seeded = await seedHelmProviders(
      h.deps.database.db,
      helmEnv([{ ...HELM_PROVIDER, slug: "taken" }]),
    );
    expect(seeded.conflicts).toEqual(["taken"]);
    expect((await admin.get(`${BASE}/${res.json.provider.id}`)).json.provider.managedBy).toBe(
      "console",
    );
  });
});

describe("without the envelope key", () => {
  it("refuses console providers (their secret could not be sealed)", async () => {
    const app = createApp({ ...h.deps, envelope: undefined });
    const b = new TestBrowser(app, PUBLIC_URL);
    expect(
      (
        await b.post("/api/auth/sign-in/email", {
          email: "root@sso.test",
          password: "a long enough password",
        })
      ).status,
    ).toBe(200);
    const res = await b.post(BASE, entraBody({ slug: "no-envelope" }));
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("credentials_unavailable");
  });
});

describe("the kill switch auth.sso.enabled: false (ac-5)", () => {
  it("hides every SSO route and the console page, Helm providers included", async () => {
    const off = { ...h.deps.sso, settings: { ...h.deps.sso.settings, enabled: false } };
    const app = createApp({ ...h.deps, sso: off });
    const b = new TestBrowser(app, PUBLIC_URL);
    expect(
      (
        await b.post("/api/auth/sign-in/email", {
          email: "root@sso.test",
          password: "a long enough password",
        })
      ).status,
    ).toBe(200);
    for (const [method, path] of [
      ["GET", BASE],
      ["POST", BASE],
      ["POST", `${BASE}/test`],
      ["GET", `${BASE}/${randomUUID()}`],
      ["PATCH", `${BASE}/${randomUUID()}`],
      ["DELETE", `${BASE}/${randomUUID()}`],
    ] as const) {
      const res =
        method === "GET"
          ? await b.get(path)
          : method === "POST"
            ? await b.post(path, entraBody({ slug: "off" }))
            : method === "PATCH"
              ? await b.patch(path, { enabled: true })
              : await b.delete(path);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // The access mapping routes too (finding 7), site and team.
    for (const [method, path] of [
      ["GET", "/v1/site/sso/mappings"],
      ["POST", `/v1/site/sso/providers/${randomUUID()}/mappings`],
      ["DELETE", `/v1/site/sso/providers/${randomUUID()}/mappings/${randomUUID()}`],
    ] as const) {
      const res =
        method === "GET"
          ? await b.get(path)
          : method === "POST"
            ? await b.post(path, { claimValue: "x", teamId: randomUUID(), role: "member" })
            : await b.delete(path);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const team = await admin.post("/v1/site/teams", {
      slug: `kill-${randomUUID().slice(0, 8)}`,
      name: "Kill",
      adminUserId: adminId,
    });
    expect(team.status, team.text).toBe(201);
    b.team = team.json.team.id;
    expect((await b.put("/v1/me/teams/active", { teamId: b.team })).status).toBeLessThan(300);
    expect((await b.get("/v1/team/sso-mappings")).status).toBe(404);
    expect((await b.get("/v1/team/members")).status).toBe(200);
    expect((await b.get("/v1/me")).json.siteFeatures).toBeUndefined();
    // Local sign-in is unaffected (the sign-in above).
    expect(adminId).not.toBe("");
  });
});
