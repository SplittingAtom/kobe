import { randomUUID } from "node:crypto";
import { expect, type Browser, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./constants.js";
import { pageApi } from "./gate5.js";

/**
 * Single sign-on against the mock identity provider (KOBE-634): e2e/sso/mock-entra.mjs registered
 * on the deployment as a separate generic OIDC provider (never the real Entra one). The deployment
 * side is in e2e/sso/gate1-mock-idp.sh; the variables are listed in README.md.
 */
export const MOCK = {
  issuer: process.env["KOBE_SSO_MOCK_ISSUER"] ?? "",
  clientId: process.env["KOBE_SSO_MOCK_CLIENT_ID"] ?? "",
  clientSecret: process.env["KOBE_SSO_MOCK_CLIENT_SECRET"] ?? "",
  slug: process.env["KOBE_SSO_MOCK_SLUG"] ?? "e2e-mock",
  name: process.env["KOBE_SSO_MOCK_NAME"] ?? "Mock IdP (e2e)",
} as const;

/** The app role the spec maps to the team (only the mock's people carry it). */
export const MOCK_ROLE = "kobe.e2e.member";
/** Addresses of the people the spec makes; never a real domain. */
export const MOCK_DOMAIN = "sso-e2e.test";

/** A person as the mock puts them in the ID token (`mock_user`). */
export interface MockPerson {
  readonly oid: string;
  readonly upn: string;
  readonly name: string;
  readonly email?: string;
  readonly roles?: readonly string[];
  readonly amr?: readonly string[];
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** A new person with a verified address and MFA in `amr` (the generic preset's proof). */
export function newPerson(label: string, overrides: Partial<MockPerson> = {}): MockPerson {
  const tag = randomUUID().slice(0, 8);
  const upn = `sso-e2e-${label}-${tag}@${MOCK_DOMAIN}`;
  return {
    oid: randomUUID(),
    upn,
    email: upn,
    name: `SSO e2e ${label} ${tag}`,
    roles: [MOCK_ROLE],
    amr: ["pwd", "mfa"],
    extra: { email_verified: true },
    ...overrides,
  };
}

export interface Provider {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly managedBy: "console" | "helm";
}

/**
 * A browser with no session. It accepts the mock's private CA: the mock is reached at its
 * in-cluster name, which Chromium maps to the ingress (KOBE_SSO_MOCK_MAP, playwright.config.ts).
 */
export async function freshBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: undefined, ignoreHTTPSErrors: true });
  return context.newPage();
}

/** Answers the mock's authorize step as `person` (the test-only `mock_user` parameter). */
export async function signInAs(page: Page, person: MockPerson): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith("/oauth2/v2.0/authorize"),
    (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set("mock_user", Buffer.from(JSON.stringify(person)).toString("base64url"));
      return route.continue({ url: url.href });
    },
  );
  await page.goto("/sign-in");
  await page.getByRole("link", { name: `Sign in with ${MOCK.name}` }).click();
}

/** Waits for the chat after a successful SSO sign-in. */
export async function expectSignedIn(page: Page, email: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/", { timeout: SHELL_TIMEOUT_MS });
  await expect.poll(() => sessionEmail(page), { timeout: SHELL_TIMEOUT_MS }).toBe(email);
}

/** The signed-in user's address, or null without a session. */
export async function sessionEmail(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const res = await fetch("/api/auth/get-session", { credentials: "same-origin" });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { user?: { email?: string } } | null;
    return body?.user?.email ?? null;
  });
}

/** Signs in with email and password on the sign-in page (the local proof of the link flow). */
export async function passwordSignIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/**
 * Finds the mock provider, or registers it (console-managed) from KOBE_SSO_MOCK_*, and turns it on.
 * Returns it and whether this run turned it on (and so turns it off again).
 */
export async function ensureProvider(
  owner: Page,
): Promise<{ provider: Provider | null; turnedOn: boolean; reason?: string }> {
  const list = await pageApi<{ providers?: Provider[] }>(owner, "GET", "/v1/site/sso/providers");
  if (list.status === 404) return { provider: null, turnedOn: false, reason: "SSO is off here" };
  let provider = list.json.providers?.find((p) => p.slug === MOCK.slug) ?? null;
  let created = false;
  if (!provider) {
    if (!MOCK.clientId || !MOCK.clientSecret) {
      return {
        provider: null,
        turnedOn: false,
        reason: "provider missing; set the client id/secret",
      };
    }
    const made = await pageApi<{ provider?: Provider; message?: string }>(
      owner,
      "POST",
      "/v1/site/sso/providers",
      {
        kind: "oidc",
        slug: MOCK.slug,
        displayName: MOCK.name,
        issuer: MOCK.issuer,
        clientId: MOCK.clientId,
        clientSecret: MOCK.clientSecret,
        subjectClaim: "oid",
        accessClaim: "roles",
        jitProvisioning: true,
      },
    );
    expect(made.status, `register the mock provider: ${made.json.message ?? ""}`).toBe(201);
    provider = made.json.provider ?? null;
    created = true;
  }
  if (!provider || provider.managedBy === "helm") return { provider, turnedOn: false };
  // A provider this run registered is turned off again at the end, like one it turned on.
  if (provider.enabled) return { provider, turnedOn: created };
  const on = await pageApi(owner, "PATCH", `/v1/site/sso/providers/${provider.id}`, {
    enabled: true,
  });
  expect(on.status, "turn the mock provider on").toBe(200);
  return { provider: { ...provider, enabled: true }, turnedOn: true };
}

/** A live SCIM token for the provider (earlier runs' live tokens are revoked first). */
export async function scimToken(
  owner: Page,
  providerId: string,
): Promise<{ token: string; id: string; baseUrl: string }> {
  const path = `/v1/site/sso/providers/${providerId}/scim`;
  const setup = await pageApi<{ tokens?: { id: string; revokedAt: string | null }[] }>(
    owner,
    "GET",
    path,
  );
  for (const t of setup.json.tokens ?? []) {
    if (t.revokedAt === null) await pageApi(owner, "POST", `${path}/tokens/${t.id}/revoke`);
  }
  const made = await pageApi<{ token: string; credential: { id: string }; baseUrl: string }>(
    owner,
    "POST",
    `${path}/tokens`,
  );
  expect(made.status, "create a SCIM token").toBe(201);
  return { token: made.json.token, id: made.json.credential.id, baseUrl: made.json.baseUrl };
}
