import { expect, test, type Page } from "@playwright/test";
import { entra, provisionUser, scimClient, type ScimClient } from "../../sso/scim-client.mjs";
import { SHELL_TIMEOUT_MS, STORAGE_STATE } from "./support/constants.js";
import { pageApi } from "./support/gate5.js";
import { panelOf } from "./support/panel.js";
import {
  MOCK,
  MOCK_ROLE,
  ensureProvider,
  expectSignedIn,
  freshBrowser,
  newPerson,
  passwordSignIn,
  scimToken,
  sessionEmail,
  signInAs,
  type MockPerson,
  type Provider,
} from "./support/sso.js";

/**
 * KOBE-634 (spec sso-oidc-scim §17 SSO-10): single sign-on in the browser against the mock
 * identity provider (e2e/sso/mock-entra.mjs), registered as its own generic OIDC provider
 * (KOBE_SSO_MOCK_SLUG, default `e2e-mock`) beside any real provider, which this spec never
 * touches. Deployment: e2e/sso/gate1-mock-idp.sh. KOBE_USER is the Owner and a team admin of
 * its active team; the link test also needs KOBE_USER2 / KOBE_PW2 (a local account without 2FA).
 *
 * 1. The sign-in page shows "Sign in with <mock>".
 * 2. A first SSO sign-in creates the account from the access mapping (app role → the team,
 *    Member); the Team console shows the row "Managed by <mock>" without Remove; Take over makes
 *    it the team's own.
 * 3. An SSO sign-in with member2's address is refused as `not_allowed`; member2's password then
 *    leads to the confirm page; Link; the next SSO sign-in is member2; Unlink in Me.
 * 4. SCIM (the mock's Entra-shaped client) provisions a person, who signs in; SCIM deactivation
 *    ends that browser's session at once and the next SSO sign-in says deactivated.
 *
 * Leaves the provider as it found it (turned off again when this run turned it on), deletes the
 * mapping and revokes the SCIM token. People it made stay as deactivated accounts (Kobe never
 * deletes users). No model tokens. Run: `npx playwright test sso`.
 */
const USER2 = process.env["KOBE_USER2"];
const PW2 = process.env["KOBE_PW2"];

test.describe.configure({ mode: "serial" });

let owner: Page;
let provider: Provider | null = null;
let turnedOn = false;
let mappingId: string | null = null;
let team: { id: string; name: string } | null = null;
let scim: ScimClient | null = null;
let scimTokenId: string | null = null;
/** People this run made, removed from the team and deactivated through SCIM at the end. */
const made: MockPerson[] = [];

test.beforeAll(async ({ browser }) => {
  owner = await (await browser.newContext({ storageState: STORAGE_STATE })).newPage();
  await owner.goto("/");
  if (!MOCK.issuer) return;
  const ensured = await ensureProvider(owner);
  provider = ensured.provider;
  turnedOn = ensured.turnedOn;
  if (!provider) return;

  const current = await pageApi<{ team: { id: string; name: string }; role: string }>(
    owner,
    "GET",
    "/v1/team",
  );
  expect(current.json.role, "KOBE_USER is a team admin of its active team").toBe("team_admin");
  team = current.json.team;
  const mapping = await pageApi<{ mapping?: { id: string } }>(
    owner,
    "POST",
    `/v1/site/sso/providers/${provider.id}/mappings`,
    { claimValue: MOCK_ROLE, teamId: team.id, role: "member" },
  );
  if (mapping.status === 201) mappingId = mapping.json.mapping?.id ?? null;
  else expect(mapping.status, "map the e2e app role to the team").toBe(409);

  const t = await scimToken(owner, provider.id);
  scimTokenId = t.id;
  scim = scimClient({ base: t.baseUrl, token: t.token });
});

test.afterAll(async () => {
  if (!owner || !provider) return;
  const members = await pageApi<{ members?: { userId: string; email: string }[] }>(
    owner,
    "GET",
    "/v1/team/members",
  );
  for (const person of made) {
    const row = members.json.members?.find((m) => m.email === person.upn.toLowerCase());
    if (row) {
      await pageApi(owner, "POST", `/v1/team/members/${row.userId}/take-over`);
      await pageApi(owner, "DELETE", `/v1/team/members/${row.userId}`);
    }
    if (scim) {
      const found = await entra.findByExternalId(scim, person.oid);
      const id = found.json?.Resources?.[0]?.id;
      if (id) await entra.remove(scim, id);
    }
  }
  if (mappingId) {
    await pageApi(owner, "DELETE", `/v1/site/sso/providers/${provider.id}/mappings/${mappingId}`);
  }
  if (scimTokenId) {
    await pageApi(
      owner,
      "POST",
      `/v1/site/sso/providers/${provider.id}/scim/tokens/${scimTokenId}/revoke`,
    );
  }
  if (turnedOn) {
    await pageApi(owner, "PATCH", `/v1/site/sso/providers/${provider.id}`, { enabled: false });
  }
  await owner.context().close();
});

test.beforeEach(() => {
  test.skip(!MOCK.issuer, "KOBE_SSO_MOCK_ISSUER is not set (see e2e/sso/gate1-mock-idp.sh)");
  test.skip(!provider, "The mock provider is not available on this deployment");
});

test("the sign-in page offers Sign in with the identity provider beside passkey and password", async ({
  browser,
}) => {
  const page = await freshBrowser(browser);
  try {
    await page.goto("/sign-in");
    const sso = page.getByRole("list", { name: "Single sign-on" });
    const button = sso.getByRole("link", { name: `Sign in with ${MOCK.name}` });
    await expect(button).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(button).toHaveAttribute("href", new RegExp(`/api/auth/sso/start/${MOCK.slug}\\?`));
    await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("a first sign-in creates a member from the mapping; the team admin takes the managed row over", async ({
  browser,
}) => {
  const person = newPerson("jit");
  made.push(person);
  const page = await freshBrowser(browser);
  try {
    await signInAs(page, person);
    await expectSignedIn(page, person.upn);
  } finally {
    await page.context().close();
  }

  const panel = panelOf(owner);
  await owner.goto("/admin/team/members");
  const roster = panel.getByRole("table", { name: `Members of ${team?.name}` });
  await expect(roster).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const row = roster.getByRole("row").filter({ hasText: person.upn });
  await expect(row).toContainText(`Managed by ${MOCK.name}`);
  await expect(row).toContainText("Member");
  await expect(row.getByRole("button", { name: `Remove ${person.name}` })).toHaveCount(0);

  await row.getByRole("button", { name: `Take over membership of ${person.name}` }).click();
  const dialog = owner.getByRole("alertdialog", { name: `Take over ${person.name}'s membership?` });
  await dialog.getByRole("button", { name: "Take over" }).click();
  await expect(
    panel.getByText(`${person.name}'s membership is now managed by the team.`),
  ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(row).not.toContainText(`Managed by ${MOCK.name}`);
  await expect(row.getByRole("button", { name: `Remove ${person.name}` })).toBeVisible();
});

test("linking needs the local password and a confirmation; then SSO signs in as that account", async ({
  browser,
}) => {
  test.skip(!USER2 || !PW2, "KOBE_USER2 and KOBE_PW2 are required");
  if (!USER2 || !PW2 || !provider) return;
  // member2's address, verified; no app role: member2 keeps only their own memberships.
  const person = newPerson("link", { upn: USER2, email: USER2, roles: [] });
  const page = await freshBrowser(browser);
  try {
    await signInAs(page, person);
    await page.waitForURL(/\/sign-in\?sso_error=not_allowed/, { timeout: SHELL_TIMEOUT_MS });
    await expect(page.getByRole("alert").filter({ hasText: "within 10 minutes" })).toBeVisible();

    await passwordSignIn(page, USER2, PW2);
    await page.waitForURL(/\/link-sign-in$/, { timeout: SHELL_TIMEOUT_MS });
    await expect(
      page.getByRole("heading", { name: "Link your organization sign-in" }),
    ).toBeVisible();
    // The address being linked (string hasText matches case-insensitively).
    await expect(page.locator("main strong").filter({ hasText: USER2 })).toBeVisible();
    await page.getByRole("button", { name: `Link ${MOCK.name}` }).click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: SHELL_TIMEOUT_MS });

    await page.goto("/me/sign-in-methods");
    const links = page.getByRole("table", { name: "Linked organization sign-ins" });
    await expect(links.getByRole("row").filter({ hasText: MOCK.name })).toContainText(
      "Linked by you",
      { timeout: SHELL_TIMEOUT_MS },
    );

    const again = await freshBrowser(browser);
    try {
      await signInAs(again, person);
      await expectSignedIn(again, USER2.toLowerCase());
    } finally {
      await again.context().close();
    }

    await links.getByRole("button", { name: `Unlink ${MOCK.name}` }).click();
    await page
      .getByRole("alertdialog", { name: `Unlink ${MOCK.name}?` })
      .getByRole("button", { name: "Unlink" })
      .click();
    await expect(page.getByText(`${MOCK.name} is unlinked.`)).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(
      page.getByText("No organization sign-in is linked to this account."),
    ).toBeVisible();
  } finally {
    // A no-op 404 once Unlink above ran (or before the link was made).
    if ((await sessionEmail(page)) === USER2.toLowerCase()) {
      await pageApi(page, "DELETE", `/v1/me/sso/links/${provider.id}`);
    }
    await page.context().close();
  }
});

test("SCIM deactivation signs the browser out at once", async ({ browser }) => {
  if (!scim) throw new Error("no SCIM client");
  const person = newPerson("scim");
  made.push(person);
  const provisioned = await provisionUser(scim, {
    externalId: person.oid,
    userName: person.upn,
    name: person.name,
    email: person.upn,
  });
  expect(provisioned.steps).toContain("create=201");
  const id = provisioned.id;
  if (!id) throw new Error(`SCIM create gave no id: ${provisioned.steps.join(" ")}`);

  const page = await freshBrowser(browser);
  try {
    await signInAs(page, person);
    await expectSignedIn(page, person.upn);

    const off = await entra.deactivate(scim, id);
    expect(off.status, "SCIM PATCH active False").toBe(200);
    // The session is gone by the next request, without signing out.
    expect(await sessionEmail(page)).toBeNull();
    await page.reload();
    await expect(page.getByText("to chat with your agents.")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });

    await signInAs(page, person);
    await page.waitForURL(/\/sign-in\?sso_error=deactivated/, { timeout: SHELL_TIMEOUT_MS });
    await expect(
      page.getByRole("alert").filter({ hasText: "This account is deactivated." }),
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});
