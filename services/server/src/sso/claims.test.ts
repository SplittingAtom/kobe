import { describe, expect, it } from "vitest";
import { checkIdTokenClaims, type ClaimsProvider } from "./claims.js";

const TENANT = "11111111-2222-4333-8444-555555555555";
const ENTRA: ClaimsProvider = {
  kind: "entra",
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  clientId: "client-1",
  tenantId: TENANT,
  subjectClaim: "oid",
  accessClaim: "roles",
};
const GENERIC: ClaimsProvider = {
  kind: "oidc",
  issuer: "https://idp.example.com/realms/kobe",
  clientId: "client-2",
  tenantId: null,
  subjectClaim: "sub",
  accessClaim: "groups",
};
const NOW = 2_000_000_000;
const NONCE = "nonce-value-0123456789";

const entraClaims = (over: Record<string, unknown> = {}) => ({
  iss: ENTRA.issuer,
  aud: ENTRA.clientId,
  tid: TENANT,
  oid: "oid-1",
  sub: "pairwise-sub",
  nonce: NONCE,
  iat: NOW - 5,
  nbf: NOW - 5,
  exp: NOW + 3600,
  preferred_username: "Ada@Contoso.com",
  name: "Ada Lovelace",
  roles: ["kobe.research.member"],
  ...over,
});

const check = (
  claims: Record<string, unknown>,
  provider = ENTRA,
  header: Record<string, unknown> = { alg: "RS256" },
) => checkIdTokenClaims({ header, claims, provider, expectedNonce: NONCE, nowS: NOW });

describe("checkIdTokenClaims", () => {
  it("accepts a good Entra token and keys it on oid", () => {
    const r = check(entraClaims({ amr: ["pwd", "mfa"], acr: "c1", auth_time: NOW - 30 }));
    expect(r).toMatchObject({
      ok: true,
      identity: {
        subject: "oid-1",
        email: "ada@contoso.com",
        emailVerified: false,
        name: "Ada Lovelace",
        values: ["kobe.research.member"],
        amr: ["pwd", "mfa"],
        acr: "c1",
      },
    });
  });

  it.each([
    [{ alg: "none" }, "alg"],
    [{ alg: "HS256" }, "alg"],
    [{ alg: "HS512" }, "alg"],
    [{}, "alg"],
  ])("refuses header %j", (header, which) => {
    expect(check(entraClaims(), ENTRA, header)).toMatchObject({
      ok: false,
      failure: "token_invalid",
      check: which,
    });
  });

  it.each([
    [{ iss: "https://login.microsoftonline.com/common/v2.0" }, "tenant_mismatch", "iss"],
    [{ tid: "99999999-2222-4333-8444-555555555555" }, "tenant_mismatch", "tid"],
    [{ tid: undefined }, "tenant_mismatch", "tid"],
    [{ aud: "other-client" }, "token_invalid", "aud"],
    [{ aud: ["client-1", "other"] }, "token_invalid", "aud"],
    [{ aud: ["client-1"], azp: "other" }, "token_invalid", "aud"],
    [{ nonce: "wrong" }, "token_invalid", "nonce"],
    [{ exp: NOW - 61 }, "token_invalid", "exp"],
    [{ exp: undefined }, "token_invalid", "exp"],
    [{ iat: NOW + 120 }, "token_invalid", "iat"],
    [{ nbf: NOW + 120 }, "token_invalid", "nbf"],
    [{ auth_time: NOW - 11 * 60 - 1 }, "token_invalid", "auth_time"],
    [{ oid: undefined }, "token_invalid", "subject"],
    [{ oid: "x".repeat(257) }, "token_invalid", "subject"],
  ])("refuses %j", (over, failure, which) => {
    expect(check(entraClaims(over))).toMatchObject({ ok: false, failure, check: which });
  });

  it("allows 60 s of clock skew", () => {
    expect(check(entraClaims({ exp: NOW - 30, iat: NOW + 30, nbf: NOW + 30 })).ok).toBe(true);
  });

  it("accepts several audiences when azp is the client", () => {
    expect(check(entraClaims({ aud: ["client-1", "x"], azp: "client-1" })).ok).toBe(true);
  });

  it("refuses another issuer for a generic provider as token_invalid", () => {
    const claims = { ...entraClaims(), iss: "https://evil.example.com", aud: "client-2" };
    expect(check(claims, GENERIC)).toMatchObject({ ok: false, failure: "token_invalid" });
  });

  it("reports a groups overage as null values", () => {
    const base = { ...entraClaims(), iss: GENERIC.issuer, aud: GENERIC.clientId, sub: "s1" };
    const over1 = check({ ...base, _claim_names: { groups: "src1" } }, GENERIC);
    const over2 = check({ ...base, hasgroups: true }, GENERIC);
    const fine = check({ ...base, groups: ["g1", 7, "g2"] }, GENERIC);
    expect(over1.ok && over1.identity.values).toBeNull();
    expect(over2.ok && over2.identity.values).toBeNull();
    expect(fine.ok && fine.identity.values).toEqual(["g1", "g2"]);
  });

  it("uses email_verified (generic) and xms_edov (Entra) only as hints", () => {
    const g = check(
      {
        ...entraClaims(),
        iss: GENERIC.issuer,
        aud: GENERIC.clientId,
        email: "B@x.org",
        email_verified: true,
      },
      GENERIC,
    );
    expect(g.ok && g.identity).toMatchObject({ email: "b@x.org", emailVerified: true });
    const e = check(entraClaims({ email: "c@contoso.com", xms_edov: true }));
    expect(e.ok && e.identity).toMatchObject({ email: "c@contoso.com", emailVerified: true });
    const none = check(entraClaims({ preferred_username: "not-an-address" }));
    expect(none.ok && none.identity.email).toBeNull();
  });
});
