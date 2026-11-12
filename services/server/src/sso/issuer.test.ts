import { describe, expect, it } from "vitest";
import { checkEntraTenant, checkGenericIssuer, entraIssuer, issuerFor } from "./issuer.js";

const TENANT = "11111111-2222-4333-8444-555555555555";

describe("Entra issuers are tenant-pinned (KOBE-626 ac-1)", () => {
  it("builds the v2.0 issuer from the tenant id", () => {
    expect(checkEntraTenant(TENANT.toUpperCase())).toEqual({
      ok: true,
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    });
    expect(entraIssuer(TENANT)).toBe(`https://login.microsoftonline.com/${TENANT}/v2.0`);
  });

  it.each(["common", "organizations", "consumers", "Common", " ORGANIZATIONS "])(
    "refuses the multi-tenant authority %j",
    (tenant) => {
      expect(checkEntraTenant(tenant)).toMatchObject({ ok: false, code: "multi_tenant_issuer" });
    },
  );

  it.each(["", "contoso.onmicrosoft.com", "{tenantid}", `${TENANT}/v2.0`, "not-a-guid"])(
    "refuses %j as a tenant id",
    (tenant) => {
      expect(checkEntraTenant(tenant)).toMatchObject({ ok: false });
    },
  );
});

describe("generic issuers", () => {
  it("accepts an https issuer exactly as given", () => {
    expect(checkGenericIssuer("https://idp.example.com/realms/kobe")).toEqual({
      ok: true,
      issuer: "https://idp.example.com/realms/kobe",
    });
  });

  it.each([
    "https://login.microsoftonline.com/common/v2.0",
    "https://login.microsoftonline.com/organizations/v2.0",
    "https://login.microsoftonline.com/consumers/v2.0",
    "https://login.microsoftonline.com/{tenantid}/v2.0",
    "https://login.microsoftonline.com/%7Btenantid%7D/v2.0",
    "https://other.example.com/common",
  ])("refuses the multi-tenant issuer %s (ac-1)", (issuer) => {
    expect(checkGenericIssuer(issuer)).toMatchObject({ ok: false, code: "multi_tenant_issuer" });
  });

  it.each([
    "http://idp.example.com",
    "https://idp.example.com/?tenant=x",
    "https://idp.example.com/#x",
    "https://user:pw@idp.example.com",
    "idp.example.com",
    "javascript:alert(1)",
  ])("refuses %s", (issuer) => {
    expect(checkGenericIssuer(issuer)).toMatchObject({ ok: false, code: "invalid_issuer" });
  });

  it("dispatches by kind", () => {
    expect(issuerFor({ kind: "entra", tenantId: "common" })).toMatchObject({ ok: false });
    expect(issuerFor({ kind: "oidc", issuer: "https://idp.example.com" })).toMatchObject({
      ok: true,
    });
  });
});
