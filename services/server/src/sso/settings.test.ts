import { describe, expect, it } from "vitest";
import { loadSsoSettings, secretEnvName } from "./settings.js";

const TENANT = "11111111-2222-4333-8444-555555555555";
const entra = {
  slug: "contoso",
  displayName: "Contoso",
  kind: "entra",
  tenantId: TENANT,
  clientId: "app",
};

describe("auth.sso settings (KOBE-626)", () => {
  it("is off with nothing set (the kill switch defaults closed)", () => {
    const s = loadSsoSettings({});
    expect(s.enabled).toBe(false);
    expect(s.helmProviders).toEqual([]);
    expect(s.allowedPorts).toEqual([443]);
  });

  it("reads the switch, the SSRF exceptions and the providers with their secrets", () => {
    const s = loadSsoSettings({
      KOBE_SSO_ENABLED: "true",
      KOBE_SSO_ALLOWED_INTERNAL_CIDRS: "10.20.0.0/16, 192.168.5.0/24",
      KOBE_SSO_ALLOWED_PORTS: "443,8443",
      KOBE_SSO_PROVIDERS: JSON.stringify([
        entra,
        {
          slug: "key-cloak",
          displayName: "Keycloak",
          kind: "oidc",
          issuer: "https://kc.example.com/realms/k",
          clientId: "kobe",
          accessClaim: "groups",
        },
      ]),
      KOBE_SSO_CLIENT_SECRET_CONTOSO: "s3cret",
      KOBE_SSO_CLIENT_SECRET_KEY_CLOAK: "other",
    });
    expect(s.enabled).toBe(true);
    expect(s.allowedInternalCidrs).toEqual(["10.20.0.0/16", "192.168.5.0/24"]);
    expect(s.allowedPorts).toEqual([443, 8443]);
    expect(s.helmProviders[0]).toMatchObject({
      slug: "contoso",
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      tenantId: TENANT,
      subjectClaim: "oid",
      accessClaim: "roles",
      mfaRule: { acrs_any: ["c1"] },
      enabled: true,
    });
    expect(s.helmProviders[1]).toMatchObject({
      subjectClaim: "sub",
      accessClaim: "groups",
      tenantId: null,
    });
    expect([...s.helmSecrets.entries()]).toEqual([
      ["contoso", "s3cret"],
      ["key-cloak", "other"],
    ]);
  });

  it("maps a slug to its secret env var one to one", () => {
    expect(secretEnvName("key-cloak")).toBe("KOBE_SSO_CLIENT_SECRET_KEY_CLOAK");
  });

  it.each([
    [{ KOBE_SSO_ENABLED: "yes" }, /KOBE_SSO_ENABLED/],
    [{ KOBE_SSO_ALLOWED_INTERNAL_CIDRS: "0.0.0.0/0" }, /ALLOWED_INTERNAL_CIDRS/],
    [{ KOBE_SSO_ALLOWED_INTERNAL_CIDRS: "nope" }, /ALLOWED_INTERNAL_CIDRS/],
    [{ KOBE_SSO_ALLOWED_PORTS: "70000" }, /ALLOWED_PORTS/],
    [{ KOBE_SSO_PROVIDERS: "{" }, /JSON array/],
    [{ KOBE_SSO_PROVIDERS: JSON.stringify([{ ...entra, tenantId: "common" }]) }, /tenant-specific/],
    [
      {
        KOBE_SSO_PROVIDERS: JSON.stringify([
          {
            ...entra,
            tenantId: undefined,
            kind: "oidc",
            issuer: "https://login.microsoftonline.com/organizations/v2.0",
          },
        ]),
      },
      /tenant-specific/,
    ],
    [
      { KOBE_SSO_PROVIDERS: JSON.stringify([{ ...entra, issuer: "https://x.example.com" }]) },
      /tenantId, not issuer/,
    ],
    [{ KOBE_SSO_PROVIDERS: JSON.stringify([entra, entra]) }, /appears twice/],
    [
      { KOBE_SSO_PROVIDERS: JSON.stringify([{ ...entra, clientSecret: "inline" }]) },
      /providers\[0\]/,
    ],
  ])("fails fast on %j", (env, message) => {
    expect(() => loadSsoSettings(env)).toThrow(message);
  });

  it("never echoes a value in its errors", () => {
    expect(() =>
      loadSsoSettings({
        KOBE_SSO_PROVIDERS: JSON.stringify([{ ...entra, clientSecret: "do-not-print-me" }]),
      }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("do-not-print-me") }));
  });
});
