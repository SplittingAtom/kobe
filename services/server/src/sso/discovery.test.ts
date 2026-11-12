import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDiscovery } from "./discovery.js";
import { guardedFetch, SsoNetError, type SsoNet } from "./net.js";
import { FakeIdp, resolver } from "./testing.js";

const TENANT = "11111111-2222-4333-8444-555555555555";
const ENTRA = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const KC = "https://kc.example.com/realms/kobe";

function net(idp: FakeIdp, policy: Partial<SsoNet["policy"]> = {}): SsoNet {
  return {
    timeoutMs: 2000,
    request: idp.request,
    policy: {
      allowHttp: false,
      allowedPorts: [443],
      allowedInternalCidrs: [],
      deniedCidrs: [],
      resolve: resolver(),
      ...policy,
    },
  };
}

const failed = (r: Awaited<ReturnType<typeof validateDiscovery>>) =>
  r.checks.filter((c) => !c.ok).map((c) => c.id);

describe("discovery validation (KOBE-626)", () => {
  it("passes a tenant-pinned Entra issuer and lists every check", async () => {
    // Entra does not advertise code_challenge_methods_supported: the Entra preset assumes S256.
    const idp = new FakeIdp().discovery(ENTRA, {
      code_challenge_methods_supported: undefined,
      authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
      token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
    });
    const report = await validateDiscovery(net(idp), { kind: "entra", tenantId: TENANT });
    expect(report).toMatchObject({ ok: true, issuer: ENTRA });
    expect(report.checks.map((c) => c.id)).toEqual([
      "tenant_pinned",
      "address_allowed",
      "reachable",
      "issuer_match",
      "code_flow",
      "pkce_s256",
      "endpoints_allowed",
    ]);
    expect(idp.hits).toEqual([`${ENTRA}/.well-known/openid-configuration`]);
  });

  it.each(["common", "organizations", "consumers"])(
    "refuses the Entra authority %s before any request (ac-1)",
    async (tenantId) => {
      const idp = new FakeIdp();
      const report = await validateDiscovery(net(idp), { kind: "entra", tenantId });
      expect(report).toMatchObject({ ok: false, failure: "multi_tenant_issuer", issuer: null });
      expect(idp.hits).toEqual([]);
    },
  );

  it("refuses a generic issuer naming a multi-tenant authority (ac-1)", async () => {
    const idp = new FakeIdp();
    const report = await validateDiscovery(net(idp), {
      kind: "oidc",
      issuer: "https://login.microsoftonline.com/common/v2.0",
    });
    expect(report).toMatchObject({ ok: false, failure: "multi_tenant_issuer" });
    expect(idp.hits).toEqual([]);
  });

  it("refuses a discovery document whose issuer differs (ac-2)", async () => {
    const idp = new FakeIdp().discovery(KC, { issuer: "https://kc.example.com/realms/other" });
    const report = await validateDiscovery(net(idp), { kind: "oidc", issuer: KC });
    expect(report).toMatchObject({ ok: false, failure: "issuer_mismatch" });
    expect(failed(report)).toEqual(["issuer_match"]);
  });

  it("refuses an Entra document naming another tenant or the {tenantid} placeholder (ac-2)", async () => {
    // openid-client itself tolerates any issuer from login.microsoftonline.com; Kobe does not.
    for (const issuer of [
      "https://login.microsoftonline.com/{tenantid}/v2.0",
      "https://login.microsoftonline.com/99999999-2222-4333-8444-555555555555/v2.0",
    ]) {
      const idp = new FakeIdp().discovery(ENTRA, { issuer });
      const report = await validateDiscovery(net(idp), { kind: "entra", tenantId: TENANT });
      expect(report, issuer).toMatchObject({ ok: false, failure: "issuer_mismatch" });
    }
  });

  it("refuses an issuer differing only by a trailing slash (exact match)", async () => {
    const idp = new FakeIdp().discovery(KC, { issuer: `${KC}/` });
    const report = await validateDiscovery(net(idp), { kind: "oidc", issuer: KC });
    expect(report).toMatchObject({ ok: false, failure: "issuer_mismatch" });
  });

  it("refuses a generic provider without PKCE S256", async () => {
    for (const methods of [undefined, ["plain"]]) {
      const idp = new FakeIdp().discovery(KC, { code_challenge_methods_supported: methods });
      const report = await validateDiscovery(net(idp), { kind: "oidc", issuer: KC });
      expect(report).toMatchObject({ ok: false, failure: "no_pkce_s256" });
    }
  });

  it("refuses a provider without the code flow", async () => {
    const idp = new FakeIdp().discovery(KC, { response_types_supported: ["id_token"] });
    expect(await validateDiscovery(net(idp), { kind: "oidc", issuer: KC })).toMatchObject({
      ok: false,
      failure: "no_code_flow",
    });
  });

  it("reports an unreachable or non-JSON discovery URL", async () => {
    expect(await validateDiscovery(net(new FakeIdp()), { kind: "oidc", issuer: KC })).toMatchObject(
      { ok: false, failure: "not_discovery_document" },
    );
  });
});

describe("SSRF guard on discovery (KOBE-626 ac-6)", () => {
  it("refuses an http issuer", async () => {
    const idp = new FakeIdp();
    const report = await validateDiscovery(net(idp), {
      kind: "oidc",
      issuer: "http://kc.example.com",
    });
    expect(report).toMatchObject({ ok: false, failure: "invalid_issuer" });
    expect(idp.hits).toEqual([]);
  });

  it("refuses any http URL in the guarded fetch", async () => {
    const idp = new FakeIdp();
    await expect(
      guardedFetch(net(idp))("http://kc.example.com/token", { method: "POST", headers: {} }),
    ).rejects.toMatchObject({ code: "https_required" });
    expect(idp.hits).toEqual([]);
  });

  it.each(["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.77.10", "fd00::1"])(
    "refuses an issuer resolving to %s",
    async (address) => {
      const idp = new FakeIdp().discovery(KC);
      const report = await validateDiscovery(
        net(idp, { resolve: resolver({ "kc.example.com": [address] }) }),
        { kind: "oidc", issuer: KC },
      );
      expect(report).toMatchObject({ ok: false, failure: "address_not_allowed" });
      expect(idp.hits).toEqual([]);
    },
  );

  it("accepts a private address listed in auth.sso.allowedInternalCidrs (on-prem IdP)", async () => {
    const idp = new FakeIdp().discovery(KC);
    const report = await validateDiscovery(
      net(idp, {
        resolve: resolver({ "kc.example.com": ["10.20.3.4"] }),
        allowedInternalCidrs: ["10.20.0.0/16"],
      }),
      { kind: "oidc", issuer: KC },
    );
    expect(report).toMatchObject({ ok: true });
  });

  it("refuses a discovery URL that redirects (to a private address)", async () => {
    const idp = new FakeIdp().redirect(
      `${KC}/.well-known/openid-configuration`,
      "http://10.0.0.1/.well-known/openid-configuration",
    );
    const report = await validateDiscovery(net(idp), { kind: "oidc", issuer: KC });
    expect(report).toMatchObject({ ok: false, failure: "redirect_refused" });
    expect(idp.hits).toEqual([`${KC}/.well-known/openid-configuration`]);
  });

  it("refuses endpoints that point at private or http addresses", async () => {
    for (const doc of [
      { jwks_uri: "https://metadata.internal/keys" },
      { token_endpoint: "http://kc.example.com/token" },
      { authorization_endpoint: "https://10.1.1.1/authorize" },
    ]) {
      const idp = new FakeIdp().discovery(KC, doc);
      const report = await validateDiscovery(
        net(idp, { resolve: resolver({ "metadata.internal": ["169.254.169.254"] }) }),
        { kind: "oidc", issuer: KC },
      );
      expect(report, JSON.stringify(doc)).toMatchObject({
        ok: false,
        failure: "endpoint_not_allowed",
      });
    }
  });

  it("refuses a port that is not allowed", async () => {
    const idp = new FakeIdp();
    const report = await validateDiscovery(net(idp), {
      kind: "oidc",
      issuer: "https://kc.example.com:8443/realms/kobe",
    });
    expect(report).toMatchObject({ ok: false, failure: "port_not_allowed" });
  });
});

describe("the real pinned request (KOBE-626 ac-6)", () => {
  // A local server stands in for the IdP; http and loopback are allowed for this test only.
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(302, { location: "http://10.0.0.1/.well-known/openid-configuration" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("does not follow a redirect to a private address", async () => {
    const live: SsoNet = {
      timeoutMs: 2000,
      policy: {
        allowHttp: true,
        allowedPorts: [port],
        allowedInternalCidrs: ["127.0.0.0/8"],
        deniedCidrs: [],
        resolve: async () => ["127.0.0.1"],
      },
    };
    await expect(
      guardedFetch(live)(`http://idp.test:${port}/.well-known/openid-configuration`, {
        method: "GET",
        headers: {},
      }),
    ).rejects.toEqual(new SsoNetError("redirect_refused"));
    expect(hits).toEqual(["/.well-known/openid-configuration"]);
  });
});
