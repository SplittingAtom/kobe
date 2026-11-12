import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as jose from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { checkIdTokenClaims, type ClaimsProvider } from "../sso/claims.js";
import { acrsClaimsParameter, mfaProven } from "../sso/mfa.js";
import { kindDefaults } from "../sso/schemas.js";

/**
 * Unit tests of the k3d SSO gate's mock Entra and SCIM client (KOBE-633, e2e/sso/): every token
 * the mock issues goes through Kobe's own claim checks (`checkIdTokenClaims`) and MFA rule, so the
 * gate's scenarios mean what they say. The modules are plain JavaScript run in a server pod.
 */
const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string) =>
  import(pathToFileURL(resolve(here, "../../../../e2e/sso", name)).href);

const TENANT = randomUUID();
const TENANT_B = randomUUID();
const CLIENT_ID = randomUUID();
const SECRET = "mock-client-secret";
const REDIRECT = "http://kobe.test/api/auth/sso/callback/entra-mock";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const PROVIDER: ClaimsProvider = {
  kind: "entra",
  issuer: ISSUER,
  clientId: CLIENT_ID,
  tenantId: TENANT,
  subjectClaim: "oid",
  accessClaim: "roles",
  allowedEmailDomains: ["sso.test"],
};

let m: any;
let scimMod: any;
let mock: any;
let jwks: ReturnType<typeof jose.createLocalJWKSet>;

beforeAll(async () => {
  m = await load("mock-entra.mjs");
  scimMod = await load("scim-client.mjs");
  mock = await m.createMockEntra({
    jose,
    tenants: [TENANT, TENANT_B],
    clientId: CLIENT_ID,
    clientSecret: SECRET,
  });
  const keys = await mock.handle({ method: "GET", path: `/${TENANT}/discovery/v2.0/keys` });
  jwks = jose.createLocalJWKSet(JSON.parse(keys.body));
});

interface Flow {
  readonly user?: Record<string, unknown>;
  readonly mode?: string;
  readonly claims?: string;
  readonly tenant?: string;
}

/** Kobe's side of one sign-in: authorize, then the token request; returns the raw parts. */
async function signIn(flow: Flow = {}) {
  const tenant = flow.tenant ?? TENANT;
  const verifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT,
    scope: "openid profile email",
    state: "st-1",
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
    ...(flow.claims ? { claims: flow.claims } : {}),
    ...(flow.user ? { mock_user: m.encodeUser(flow.user) } : {}),
    ...(flow.mode ? { mock_mode: flow.mode } : {}),
  });
  const auth = await mock.handle({
    method: "GET",
    path: `/${tenant}/oauth2/v2.0/authorize?${q}`,
  });
  const back = new URL(auth.headers.location ?? "http://none/");
  const code = back.searchParams.get("code");
  const tokenRequest = (body: Record<string, string>, secret = SECRET) =>
    mock.handle({
      method: "POST",
      path: `/${tenant}/oauth2/v2.0/token`,
      headers: {
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams(body).toString(),
    });
  const form = {
    grant_type: "authorization_code",
    code: code ?? "",
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  };
  return { auth, back, code, nonce, form, tokenRequest };
}

async function idTokenOf(flow: Flow = {}) {
  const s = await signIn(flow);
  const res = await s.tokenRequest(s.form);
  expect(res.status, res.body).toBe(200);
  const token: string = JSON.parse(res.body).id_token;
  return { token, nonce: s.nonce };
}

/** What Kobe concludes from a token: signature against the JWKS, then its own claim checks. */
async function kobeVerdict(token: string, nonce: string, provider = PROVIDER) {
  const header = jose.decodeProtectedHeader(token) as Record<string, unknown>;
  let signature = "ok";
  try {
    await jose.jwtVerify(token, jwks, { algorithms: ["RS256", "ES256"] });
  } catch (err) {
    // Time claims are judged by checkIdTokenClaims below; a bad signature or alg is not.
    const code = (err as { code?: string }).code ?? "";
    if (!/ERR_JWT_EXPIRED|ERR_JWT_CLAIM_VALIDATION_FAILED/.test(code)) signature = code || "bad";
  }
  const claims = jose.decodeJwt(token) as Record<string, unknown>;
  return {
    signature,
    check: checkIdTokenClaims({ header, claims, provider, expectedNonce: nonce }),
  };
}

const MEMBER = { oid: randomUUID(), upn: "ann@sso.test", name: "Ann Lee", roles: ["Kobe.Member"] };

describe("mock Entra: discovery and keys", () => {
  it("serves Entra's v2.0 discovery document for a configured tenant only", async () => {
    const res = await mock.handle({
      method: "GET",
      path: `/${TENANT}/v2.0/.well-known/openid-configuration`,
    });
    expect(res.status).toBe(200);
    const doc = JSON.parse(res.body);
    expect(doc).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
      token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
      id_token_signing_alg_values_supported: ["RS256"],
    });
    expect(doc.response_types_supported).toContain("code");
    // Like Entra: PKCE supported but not advertised (Kobe's Entra preset assumes it).
    expect(doc.code_challenge_methods_supported).toBeUndefined();
    const other = await mock.handle({
      method: "GET",
      path: `/${randomUUID()}/v2.0/.well-known/openid-configuration`,
    });
    expect(other.status).toBe(400);
    expect(JSON.parse(other.body).error_description).toMatch(/^AADSTS90002/);
  });

  it("publishes one RS256 key with kid and x5t", async () => {
    const res = await mock.handle({ method: "GET", path: `/${TENANT}/discovery/v2.0/keys` });
    const { keys } = JSON.parse(res.body);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "RSA", use: "sig", kid: mock.kid, x5t: mock.kid });
    expect(keys[0].d).toBeUndefined();
  });
});

describe("mock Entra: the code flow", () => {
  it("issues an ID token Kobe accepts, with Entra's claims", async () => {
    const { token, nonce } = await idTokenOf({ user: MEMBER });
    const verdict = await kobeVerdict(token, nonce);
    expect(verdict.signature).toBe("ok");
    expect(verdict.check).toMatchObject({
      ok: true,
      identity: {
        subject: MEMBER.oid,
        email: "ann@sso.test",
        emailVerified: true,
        values: ["Kobe.Member"],
      },
    });
    const claims = jose.decodeJwt(token);
    expect(claims).toMatchObject({
      tid: TENANT,
      ver: "2.0",
      oid: MEMBER.oid,
      preferred_username: "ann@sso.test",
    });
    expect(claims.sub).not.toBe(MEMBER.oid);
    expect(jose.decodeProtectedHeader(token)).toMatchObject({
      alg: "RS256",
      kid: mock.kid,
      typ: "JWT",
    });
  });

  it("redirects back with code, state and session_state", async () => {
    const s = await signIn({ user: MEMBER });
    expect(s.auth.status).toBe(302);
    expect(s.back.origin + s.back.pathname).toBe(REDIRECT);
    expect(s.back.searchParams.get("state")).toBe("st-1");
    expect(s.back.searchParams.get("session_state")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("checks the client secret, single-use codes, the redirect URI and PKCE", async () => {
    const s = await signIn({ user: MEMBER });
    expect((await s.tokenRequest(s.form, "wrong")).status).toBe(401);
    // The failed attempt spent the code (Entra codes are single use).
    const t = await signIn({ user: MEMBER });
    expect((await t.tokenRequest(t.form)).status).toBe(200);
    const replay = await t.tokenRequest(t.form);
    expect(JSON.parse(replay.body)).toMatchObject({ error: "invalid_grant", error_codes: [70008] });
    const u = await signIn({ user: MEMBER });
    const pkce = await u.tokenRequest({ ...u.form, code_verifier: "x".repeat(43) });
    expect(JSON.parse(pkce.body).error).toBe("invalid_grant");
    const v = await signIn({ user: MEMBER });
    const redirect = await v.tokenRequest({ ...v.form, redirect_uri: "http://evil.test/cb" });
    expect(JSON.parse(redirect.body).error).toBe("invalid_grant");
  });

  it("refuses an authorization request without PKCE S256 and answers deny with access_denied", async () => {
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT,
      scope: "openid",
      state: "s",
    });
    const res = await mock.handle({ method: "GET", path: `/${TENANT}/oauth2/v2.0/authorize?${q}` });
    expect(new URL(res.headers.location).searchParams.get("error")).toBe("invalid_request");
    const denied = await signIn({ user: MEMBER, mode: "deny" });
    expect(denied.back.searchParams.get("error")).toBe("access_denied");
    expect(denied.code).toBeNull();
  });

  it("counts requests per endpoint", async () => {
    const res = await mock.handle({ method: "GET", path: "/_mock/stats" });
    const stats = JSON.parse(res.body);
    expect(stats.authorize).toBeGreaterThan(0);
    expect(stats.token_ok).toBeGreaterThan(0);
    expect(stats.token_refused).toBeGreaterThan(0);
  });
});

describe("mock Entra: MFA (acrs) as Conditional Access answers", () => {
  const rule = kindDefaults("entra").mfaRule;
  const claims = acrsClaimsParameter("entra", rule) ?? "";

  it("puts the requested context in acrs only for a person who passes MFA", async () => {
    const proving = await idTokenOf({ user: { ...MEMBER, mfa: true }, claims });
    const yes = await kobeVerdict(proving.token, proving.nonce);
    expect(yes.check.ok && yes.check.identity.acrs).toEqual(["c1"]);
    expect(yes.check.ok && mfaProven("entra", rule, yes.check.identity)).toBe(true);

    const weak = await idTokenOf({ user: { ...MEMBER, mfa: false }, claims });
    const no = await kobeVerdict(weak.token, weak.nonce);
    expect(no.check.ok && no.check.identity.acrs).toEqual([]);
    expect(no.check.ok && mfaProven("entra", rule, no.check.identity)).toBe(false);

    // No claims request: no acrs even for a person with MFA.
    const unasked = await idTokenOf({ user: { ...MEMBER, mfa: true } });
    expect(jose.decodeJwt(unasked.token).acrs).toBeUndefined();
  });

  it("parses the claims parameter's value and values forms", () => {
    expect(m.requestedAcrs('{"id_token":{"acrs":{"essential":true,"value":"c1"}}}')).toEqual([
      "c1",
    ]);
    expect(
      m.requestedAcrs('{"id_token":{"acrs":{"essential":true,"values":["c1","c2"]}}}'),
    ).toEqual(["c1", "c2"]);
    expect(m.requestedAcrs("not json")).toEqual([]);
  });
});

describe("mock Entra: groups and overage", () => {
  const groupsProvider: ClaimsProvider = { ...PROVIDER, accessClaim: "groups" };

  it("lists up to 200 groups and reports an overage beyond", async () => {
    const few = [randomUUID(), randomUUID()];
    const a = await idTokenOf({ user: { ...MEMBER, groups: few } });
    const fine = await kobeVerdict(a.token, a.nonce, groupsProvider);
    expect(fine.check.ok && fine.check.identity.values).toEqual(few);

    const many = Array.from({ length: m.GROUPS_LIMIT + 1 }, () => randomUUID());
    const b = await idTokenOf({ user: { ...MEMBER, groups: many } });
    const claims = jose.decodeJwt(b.token);
    expect(claims.groups).toBeUndefined();
    expect(claims._claim_names).toEqual({ groups: "src1" });
    const over = await kobeVerdict(b.token, b.nonce, groupsProvider);
    expect(over.check.ok && over.check.identity.values).toBeNull();

    const c = await idTokenOf({ user: { ...MEMBER, groups: few }, mode: "overage" });
    expect(jose.decodeJwt(c.token).groups).toBeUndefined();
  });
});

describe("mock Entra: bad-token modes are refused by Kobe's checks", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    // mode, the check that fails, Kobe's failure (signature-level modes: "-")
    ["wrong_iss", "iss", "tenant_mismatch"],
    ["wrong_aud", "aud", "token_invalid"],
    ["wrong_nonce", "nonce", "token_invalid"],
    ["expired", "exp", "token_invalid"],
    ["stale_auth_time", "auth_time", "token_invalid"],
    ["missing_tid", "tid", "tenant_mismatch"],
    ["wrong_tid", "tid", "tenant_mismatch"],
    ["alg_none", "alg", "token_invalid"],
    ["hs256", "alg", "token_invalid"],
  ];
  it.each(cases)("%s fails Kobe's %s check (%s)", async (mode, check, failure) => {
    const { token, nonce } = await idTokenOf({ user: MEMBER, mode });
    const verdict = await kobeVerdict(token, nonce);
    expect(verdict.check).toMatchObject({ ok: false, check, failure });
  });

  it("alg none and HS256 also fail the signature; foreign_key fails only there", async () => {
    for (const mode of ["alg_none", "hs256", "foreign_key"]) {
      const { token, nonce } = await idTokenOf({ user: MEMBER, mode });
      expect((await kobeVerdict(token, nonce)).signature, mode).not.toBe("ok");
    }
    const hs = await idTokenOf({ user: MEMBER, mode: "hs256" });
    await expect(jose.jwtVerify(hs.token, new TextEncoder().encode(SECRET))).resolves.toBeTruthy();
    const foreign = await idTokenOf({ user: MEMBER, mode: "foreign_key" });
    expect((await kobeVerdict(foreign.token, foreign.nonce)).check.ok).toBe(true);
  });

  it("a code from one tenant is not redeemable at another", async () => {
    const s = await signIn({ user: MEMBER, tenant: TENANT_B });
    const res = await mock.handle({
      method: "POST",
      path: `/${TENANT}/oauth2/v2.0/token`,
      body: new URLSearchParams({
        ...s.form,
        client_id: CLIENT_ID,
        client_secret: SECRET,
      }).toString(),
    });
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });
});

describe("SCIM client: Entra's request shapes", () => {
  /** A recording fetch that answers like Kobe's SCIM endpoints would. */
  function recorder() {
    const calls: Array<{
      method: string;
      url: string;
      headers: Record<string, string>;
      body: any;
    }> = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, url, headers: init.headers, body });
      const list = (n: number) => ({
        schemas: [scimMod.SCIM_LIST],
        totalResults: n,
        Resources: n ? [{ id: "u-1" }] : [],
      });
      const created = calls.some((c) => c.method === "POST");
      const answer =
        init.method === "POST"
          ? { status: 201, json: { id: "u-1" } }
          : init.method === "DELETE"
            ? { status: 204, json: null }
            : init.method === "GET" && url.includes("filter=")
              ? { status: 200, json: list(url.includes("externalId") && created ? 1 : 0) }
              : { status: 200, json: { id: "u-1" } };
      return new Response(answer.json === null ? null : JSON.stringify(answer.json), {
        status: answer.status,
        headers: { "content-type": "application/scim+json" },
      });
    };
    return { calls, fetchImpl };
  }

  it("provisions: probe, match by userName, create, read back by externalId", async () => {
    const r = recorder();
    const scim = scimMod.scimClient({
      base: "http://kobe.test/v1/scim/v2/x",
      token: "kobe_scim_t",
      fetchImpl: r.fetchImpl,
    });
    const oid = randomUUID();
    const out = await scimMod.provisionUser(scim, {
      externalId: oid,
      userName: "bo@sso.test",
      name: "Bo Diaz",
    });
    expect(out).toEqual({
      steps: ["probe=200:0", "match=200:0", "create=201", "by_external_id=200:1"],
      id: "u-1",
    });
    expect(r.calls.map((c) => c.method)).toEqual(["GET", "GET", "POST", "GET"]);
    expect(decodeURIComponent(r.calls[1]?.url ?? "")).toContain('filter=userName eq "bo@sso.test"');
    expect(r.calls[0]?.headers.authorization).toBe("Bearer kobe_scim_t");
    expect(r.calls[2]?.headers["content-type"]).toBe("application/scim+json");
    expect(r.calls[2]?.body).toMatchObject({
      schemas: [scimMod.SCIM_USER, scimMod.SCIM_ENTERPRISE],
      externalId: oid,
      userName: "bo@sso.test",
      active: true,
      emails: [{ primary: true, type: "work", value: "bo@sso.test" }],
      name: { givenName: "Bo", familyName: "Diaz", formatted: "Bo Diaz" },
    });
  });

  it("sends Entra's PATCH quirks: capitalised ops, filtered paths, path-less objects, string booleans", async () => {
    const r = recorder();
    const scim = scimMod.scimClient({
      base: "http://k/v1/scim/v2/x",
      token: "t",
      fetchImpl: r.fetchImpl,
    });
    await scimMod.entra.updateAttributes(scim, "u-1", {
      email: "new@sso.test",
      familyName: "Diaz-Ruiz",
      name: "Bo Diaz-Ruiz",
      givenName: "Bo",
    });
    await scimMod.entra.deactivate(scim, "u-1");
    await scimMod.entra.deactivatePathless(scim, "u-1");
    await scimMod.entra.reactivate(scim, "u-1");
    await scimMod.entra.remove(scim, "u-1");
    const [attrs, off, offPathless, on, del] = r.calls;
    expect(attrs?.body).toEqual({
      schemas: [scimMod.SCIM_PATCH],
      Operations: [
        { op: "Replace", path: 'emails[type eq "work"].value', value: "new@sso.test" },
        { op: "Add", path: "name.familyName", value: "Diaz-Ruiz" },
        { op: "replace", value: { displayName: "Bo Diaz-Ruiz", "name.givenName": "Bo" } },
      ],
    });
    expect(off?.body.Operations).toEqual([{ op: "Replace", path: "active", value: "False" }]);
    expect(offPathless?.body.Operations).toEqual([{ op: "Replace", value: { active: "False" } }]);
    expect(on?.body.Operations).toEqual([{ op: "Replace", path: "active", value: "True" }]);
    expect(del?.method).toBe("DELETE");
    expect(del?.url).toBe("http://k/v1/scim/v2/x/Users/u-1");
    expect(scim.log).toEqual([
      "PATCH /Users/u-1 200",
      "PATCH /Users/u-1 200",
      "PATCH /Users/u-1 200",
      "PATCH /Users/u-1 200",
      "DELETE /Users/u-1 204",
    ]);
  });

  it("reuses a user Entra's match finds instead of creating it", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: any) => {
      calls.push(init.method);
      const n = decodeURIComponent(url).includes('"bo@sso.test"') ? 1 : 0;
      return new Response(
        JSON.stringify({ totalResults: n, Resources: n ? [{ id: "u-9" }] : [] }),
        {
          status: 200,
        },
      );
    };
    const scim = scimMod.scimClient({ base: "http://k", token: "t", fetchImpl });
    const out = await scimMod.provisionUser(scim, {
      externalId: "x",
      userName: "bo@sso.test",
      name: "Bo",
    });
    expect(out.id).toBe("u-9");
    expect(calls).not.toContain("POST");
  });
});
