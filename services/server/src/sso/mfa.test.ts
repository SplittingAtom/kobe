import { describe, expect, it } from "vitest";
import { acrsClaimsParameter, mfaEvidence, mfaProven } from "./mfa.js";
import { ENTRA_MFA_RULE, GENERIC_MFA_RULE } from "./schemas.js";

/** KOBE-629 (spec sso-oidc-scim §8, SSO3): which sign-ins prove multi-factor authentication. */
const proof = (over: Partial<{ amr: string[]; acr: string | null; acrs: string[] }> = {}) => ({
  amr: [],
  acr: null,
  acrs: [],
  ...over,
});

describe("mfaProven", () => {
  it("accepts any listed amr value (RFC 8176)", () => {
    expect(mfaProven("oidc", GENERIC_MFA_RULE, proof({ amr: ["pwd", "mfa"] }))).toBe(true);
    expect(mfaProven("oidc", GENERIC_MFA_RULE, proof({ amr: ["hwk"] }))).toBe(true);
    expect(mfaProven("entra", ENTRA_MFA_RULE, proof({ amr: ["pwd", "otp"] }))).toBe(true);
  });

  it("refuses a password-only or empty proof", () => {
    expect(mfaProven("oidc", GENERIC_MFA_RULE, proof({ amr: ["pwd"] }))).toBe(false);
    expect(mfaProven("entra", ENTRA_MFA_RULE, proof())).toBe(false);
    expect(mfaProven("entra", ENTRA_MFA_RULE, proof({ acr: "1" }))).toBe(false);
  });

  it("accepts the Entra authentication context c1 in acrs (the Entra preset)", () => {
    expect(mfaProven("entra", ENTRA_MFA_RULE, proof({ amr: ["pwd"], acrs: ["c1"] }))).toBe(true);
    expect(mfaProven("entra", ENTRA_MFA_RULE, proof({ acrs: ["c2", "c1"] }))).toBe(true);
    expect(mfaProven("entra", ENTRA_MFA_RULE, proof({ acrs: ["c2"] }))).toBe(false);
  });

  it("reads acrs only for Entra providers", () => {
    const rule = { amr_any: [], acr_any: [], acrs_any: ["c1"] };
    expect(mfaProven("oidc", rule, proof({ acrs: ["c1"] }))).toBe(false);
  });

  it("accepts a listed acr value, exactly", () => {
    const rule = { amr_any: [], acr_any: ["urn:example:mfa"], acrs_any: [] };
    expect(mfaProven("oidc", rule, proof({ acr: "urn:example:mfa" }))).toBe(true);
    expect(mfaProven("oidc", rule, proof({ acr: "URN:EXAMPLE:MFA" }))).toBe(false);
    expect(mfaProven("oidc", rule, proof({ acr: null }))).toBe(false);
  });

  it("proves nothing with an empty rule", () => {
    const rule = { amr_any: [], acr_any: [], acrs_any: [] };
    expect(mfaProven("entra", rule, proof({ amr: ["mfa"], acr: "c1", acrs: ["c1"] }))).toBe(false);
  });
});

describe("mfaEvidence (review L3: what proved it, for the audit log)", () => {
  it("names the first matching claim value", () => {
    expect(mfaEvidence("entra", ENTRA_MFA_RULE, proof({ amr: ["pwd"], acrs: ["c1"] }))).toBe(
      "acrs:c1",
    );
    expect(mfaEvidence("oidc", GENERIC_MFA_RULE, proof({ amr: ["pwd", "otp"] }))).toBe("amr:otp");
    const rule = { amr_any: [], acr_any: ["gold"], acrs_any: [] };
    expect(mfaEvidence("oidc", rule, proof({ acr: "gold" }))).toBe("acr:gold");
    expect(mfaEvidence("entra", ENTRA_MFA_RULE, proof({ amr: ["pwd"] }))).toBeNull();
  });
});

describe("acrsClaimsParameter", () => {
  it("asks Entra for the one authentication context as an essential claim (§8)", () => {
    expect(acrsClaimsParameter("entra", ENTRA_MFA_RULE)).toBe(
      JSON.stringify({ id_token: { acrs: { essential: true, value: "c1" } } }),
    );
  });

  it("lists several contexts with values", () => {
    const rule = { amr_any: [], acr_any: [], acrs_any: ["c1", "c3"] };
    expect(acrsClaimsParameter("entra", rule)).toBe(
      JSON.stringify({ id_token: { acrs: { essential: true, values: ["c1", "c3"] } } }),
    );
  });

  it("sends nothing without contexts or for a generic provider", () => {
    expect(acrsClaimsParameter("entra", GENERIC_MFA_RULE)).toBeUndefined();
    expect(acrsClaimsParameter("oidc", ENTRA_MFA_RULE)).toBeUndefined();
  });
});
