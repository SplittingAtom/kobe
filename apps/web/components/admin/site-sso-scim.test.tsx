// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { SiteSsoPage } from "./site/sso-page";
import { answerConfirm, forbidNativeConfirm, renderSite, stubApi } from "./testing";

const BASE = "/v1/site/sso/providers";
const TOKEN = `kobe_scim_${"A".repeat(43)}`;
const SCIM_URL = "https://kobe.example.com/v1/scim/v2/contoso";

const provider = {
  id: "p-1",
  slug: "contoso",
  display_name: "Contoso",
  kind: "entra",
  issuer: "https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0",
  tenant_id: "11111111-2222-4333-8444-555555555555",
  client_id: "app-id",
  subject_claim: "oid",
  access_claim: "roles",
  mfa_rule: { amr_any: ["mfa"], acr_any: [], acrs_any: [] },
  allowed_email_domains: [],
  jit_provisioning: true,
  max_session_hours: null,
  enabled: true,
  managed_by: "console",
  client_secret: "set",
  redirect_uri: "https://kobe.example.com/api/auth/sso/callback/contoso",
  linked_identities: 0,
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
};
const token = (over: Record<string, unknown> = {}) => ({
  id: "t-1",
  prefix: "kobe_scim_AAAA",
  created_at: "2026-11-11T10:00:00Z",
  last_used_at: null,
  revoked_at: null,
  ...over,
});

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openPanel() {
  renderSite(<SiteSsoPage />);
  await userEvent.click(
    await screen.findByRole("button", { name: /SCIM provisioning for Contoso/ }),
  );
  return screen.findByRole("region", { name: "SCIM provisioning: Contoso" });
}

describe("SCIM tokens on the single sign-on page (KOBE-631)", () => {
  it("creates a token and shows it once, with the Tenant SCIM_URL", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { providers: [provider] }],
      [`GET ${BASE}/p-1/scim`]: [
        [200, { base_url: SCIM_URL, tokens: [] }],
        [200, { base_url: SCIM_URL, tokens: [token()] }],
      ],
      [`POST ${BASE}/p-1/scim/tokens`]: [
        201,
        { token: TOKEN, credential: token(), base_url: SCIM_URL },
      ],
    });
    const panel = await openPanel();
    expect(await within(panel).findByText(SCIM_URL)).toBeTruthy();
    await userEvent.click(within(panel).getByRole("button", { name: "Create token" }));
    expect((await within(panel).findByTestId("scim-token")).textContent).toBe(TOKEN);
    expect(within(panel).getByText(/shows it only once/)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/p-1/scim/tokens`)).toBe(
      true,
    );
    // Hidden, the token is gone from the page for good.
    await userEvent.click(within(panel).getByRole("button", { name: "Hide" }));
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(within(panel).getByText("kobe_scim_AAAA…")).toBeTruthy();
  });

  it("rotates a live token and revokes after asking", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { providers: [provider] }],
      [`GET ${BASE}/p-1/scim`]: [
        [200, { base_url: SCIM_URL, tokens: [token({ last_used_at: "2026-11-11T11:00:00Z" })] }],
        [
          200,
          { base_url: SCIM_URL, tokens: [token({ id: "t-2", prefix: "kobe_scim_BBBB" }), token()] },
        ],
        [200, { base_url: SCIM_URL, tokens: [token({ revoked_at: "2026-11-11T12:00:00Z" })] }],
      ],
      [`POST ${BASE}/p-1/scim/tokens/t-1/rotate`]: [
        201,
        { token: TOKEN, credential: token({ id: "t-2" }), base_url: SCIM_URL, replaces: "t-1" },
      ],
      [`POST ${BASE}/p-1/scim/tokens/t-1/revoke`]: [
        200,
        { credential: token({ revoked_at: "2026-11-11T12:00:00Z" }) },
      ],
    });
    const panel = await openPanel();
    await userEvent.click(await within(panel).findByRole("button", { name: /Rotate/ }));
    expect(
      await within(panel).findByText(/old token keeps working until you revoke it/),
    ).toBeTruthy();
    // Two live: no further rotation offered.
    expect(within(panel).queryByRole("button", { name: /Rotate/ })).toBeNull();
    const oldRow = must(within(panel).getByText("kobe_scim_AAAA…").closest("tr"));
    await userEvent.click(within(oldRow).getByRole("button", { name: /Revoke/ }));
    const text = await answerConfirm(/Revoke the token kobe_scim_AAAA/, "Revoke");
    expect(text).toContain("can't be turned back on");
    expect(await within(panel).findByText("Token revoked.")).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `${BASE}/p-1/scim/tokens/t-1/rotate`,
      `${BASE}/p-1/scim/tokens/t-1/revoke`,
    ]);
  });
});
