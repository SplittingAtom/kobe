import { describe, expect, it } from "vitest";
import type { SsoNet } from "./net.js";
import {
  DISCOVERY_FAILURE_TTL_MS,
  OidcClients,
  SsoFlowError,
  type SsoProvider,
} from "./oidc-flow.js";
import { FakeIdp, resolver } from "./testing.js";

/** Review finding 9c: a failed discovery is remembered briefly, so a broken IdP isn't hammered. */
const KC = "https://kc.example.com/realms/kobe";
const provider: SsoProvider = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "kc",
  displayName: "KC",
  kind: "oidc",
  issuer: KC,
  clientId: "kc-app",
  tenantId: null,
  subjectClaim: "sub",
  accessClaim: "groups",
  jitProvisioning: true,
  mfaRule: { amr_any: [], acr_any: [], acrs_any: [] },
  allowedEmailDomains: [],
  maxSessionHours: null,
};

const netOf = (idp: FakeIdp): SsoNet => ({
  timeoutMs: 2000,
  request: idp.request,
  policy: {
    allowHttp: false,
    allowedPorts: [443],
    allowedInternalCidrs: [],
    deniedCidrs: [],
    resolve: resolver(),
  },
});

async function failure(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof SsoFlowError ? err.failure : "other";
  }
}

describe("OidcClients discovery cache", () => {
  it("caches a failed discovery for a minute, then tries again", async () => {
    const idp = new FakeIdp(); // nothing served: discovery fails
    let now = 1_000_000;
    const clients = new OidcClients(netOf(idp), () => now);
    expect(await failure(clients.configure(provider, "secret"))).toBe("idp_unreachable");
    const hits = idp.hits.length;
    expect(hits).toBeGreaterThan(0);
    expect(await failure(clients.configure(provider, "secret"))).toBe("idp_unreachable");
    expect(idp.hits.length).toBe(hits);

    idp.discovery(KC);
    now += DISCOVERY_FAILURE_TTL_MS - 1;
    expect(await failure(clients.configure(provider, "secret"))).toBe("idp_unreachable");
    expect(idp.hits.length).toBe(hits);
    now += 2;
    expect(await failure(clients.configure(provider, "secret"))).toBeUndefined();
    expect(idp.hits.length).toBeGreaterThan(hits);
  });

  it("is 60 seconds", () => {
    expect(DISCOVERY_FAILURE_TTL_MS).toBe(60_000);
  });
});
