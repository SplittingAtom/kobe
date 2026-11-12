// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { SsoMappingsPage } from "./site/sso-mappings-page";
import { MembersPage, managedByLabel } from "./team/members-page";
import {
  forbidNativeConfirm,
  ME,
  answerConfirm,
  renderSite,
  renderTeam,
  stubApi,
  summary,
} from "./testing";

/** KOBE-627 (spec sso-oidc-scim §7, SSO6, SSO10): access mappings and managed memberships. */
const P = "p-entra";
const MEMBERS = {
  members: [
    {
      userId: ME.id,
      name: ME.name,
      email: ME.email,
      role: "team_admin",
      joinedAt: "2026-10-01T10:00:00Z",
      addedVia: null,
      managedBy: null,
    },
    {
      userId: "u-bob",
      name: "Bob",
      email: "b@x.io",
      role: "contributor",
      joinedAt: "2026-10-01T10:00:00Z",
      addedVia: "idp",
      managedBy: { providerId: P, providerName: "Contoso Entra" },
    },
  ],
};

beforeEach(() => {
  forbidNativeConfirm();
  vi.stubGlobal("location", { ...window.location, assign: vi.fn(), reload: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Team console: managed memberships", () => {
  it("shows Managed by <provider> and offers no role change or removal for that row", async () => {
    stubApi({ "GET /v1/team/members": [200, MEMBERS] });
    renderTeam(<MembersPage />);
    const row = must((await screen.findByText(managedByLabel("Contoso Entra"))).closest("tr"));
    expect(row.textContent).toContain("Contributor");
    expect(within(row).queryByLabelText("Role of Bob")).toBeNull();
    expect(within(row).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(within(row).getByRole("button", { name: "Take over membership of Bob" })).toBeTruthy();
    // The team's own rows keep their controls.
    expect(screen.getByLabelText(`Role of ${ME.name}`)).toBeTruthy();
  });

  it("takes a membership over after confirmation", async () => {
    const calls = stubApi({
      "GET /v1/team/members": [
        [200, MEMBERS],
        [
          200,
          {
            members: [
              MEMBERS.members[0],
              { ...MEMBERS.members[1], addedVia: null, managedBy: null },
            ],
          },
        ],
      ],
      "POST /v1/team/members/u-bob/take-over": [200, { userId: "u-bob", managedBy: null }],
    });
    renderTeam(<MembersPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Take over membership of Bob" }),
    );
    expect(summary(calls)).not.toContain("POST /v1/team/members/u-bob/take-over");
    await answerConfirm("Take over Bob's membership?", "Take over");
    await screen.findByText("Bob's membership is now managed by the team.");
    expect(summary(calls)).toContain("POST /v1/team/members/u-bob/take-over");
    expect(await screen.findByLabelText("Role of Bob")).toBeTruthy();
  });

  it("lists the team's access mappings read-only, on request", async () => {
    const calls = stubApi({
      "GET /v1/team/members": [200, MEMBERS],
      "GET /v1/team/sso-mappings": [
        200,
        {
          mappings: [
            {
              id: "m1",
              providerId: P,
              providerName: "Contoso Entra",
              claimValue: "kobe.fin.builder",
              role: "contributor",
            },
          ],
        },
      ],
    });
    renderTeam(<MembersPage />);
    await screen.findByText("Bob");
    expect(summary(calls)).not.toContain("GET /v1/team/sso-mappings");
    await userEvent.click(screen.getByRole("button", { name: "Show access mappings" }));
    const table = await screen.findByRole("table", { name: /Access mappings for this team/ });
    expect(table.textContent).toContain("kobe.fin.builder");
    expect(within(table).queryByRole("button")).toBeNull();
  });
});

const SSO = {
  providers: [
    {
      id: P,
      slug: "entra",
      displayName: "Contoso Entra",
      accessClaim: "roles",
      enabled: true,
      managedBy: "helm",
    },
  ],
  mappings: [
    {
      id: "m1",
      providerId: P,
      claimValue: "kobe.fin.member",
      teamId: "t-fin",
      teamSlug: "finance",
      teamName: "Finance",
      role: "member",
      createdAt: "2026-11-01T10:00:00Z",
    },
  ],
  appliesAt: "next_sign_in",
};
const TEAMS = { teams: [{ id: "t-fin", slug: "finance", name: "Finance" }] };

describe("Site console: SSO access mappings", () => {
  it("lists a provider's mappings and offers team roles only (SSO6)", async () => {
    stubApi({ "GET /v1/site/sso/mappings": [200, SSO], "GET /v1/site/teams": [200, TEAMS] });
    renderSite(<SsoMappingsPage />);
    const table = await screen.findByRole("table", { name: "Access mappings of Contoso Entra" });
    expect(table.textContent).toContain("kobe.fin.member");
    expect(table.textContent).toContain("Finance");
    const roles = within(screen.getByRole("form", { name: "Add a mapping to Contoso Entra" }))
      .getByLabelText("Team role")
      .querySelectorAll("option");
    expect([...roles].map((o) => o.value)).toEqual(["team_admin", "contributor", "member"]);
  });

  it("adds and deletes a mapping", async () => {
    const calls = stubApi({
      "GET /v1/site/sso/mappings": [200, SSO],
      "GET /v1/site/teams": [200, TEAMS],
      [`POST /v1/site/sso/providers/${P}/mappings`]: [201, { mapping: SSO.mappings[0] }],
      [`DELETE /v1/site/sso/providers/${P}/mappings/m1`]: [204],
    });
    renderSite(<SsoMappingsPage />);
    const form = await screen.findByRole("form", { name: "Add a mapping to Contoso Entra" });
    await userEvent.type(within(form).getByLabelText("App role or group"), "kobe.fin.admin");
    await userEvent.selectOptions(within(form).getByLabelText("Team"), "t-fin");
    await userEvent.selectOptions(within(form).getByLabelText("Team role"), "team_admin");
    await userEvent.click(within(form).getByRole("button", { name: "Add mapping" }));
    await screen.findByText("kobe.fin.admin now gives Team admin.");
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({
      claimValue: "kobe.fin.admin",
      teamId: "t-fin",
      role: "team_admin",
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Delete mapping kobe.fin.member to Finance" }),
    );
    await answerConfirm("Delete the mapping kobe.fin.member → Finance?", "Delete mapping");
    await waitFor(() =>
      expect(summary(calls)).toContain(`DELETE /v1/site/sso/providers/${P}/mappings/m1`),
    );
  });

  it("says when no provider is configured", async () => {
    stubApi({
      "GET /v1/site/sso/mappings": [200, { providers: [], mappings: [] }],
      "GET /v1/site/teams": [200, TEAMS],
    });
    renderSite(<SsoMappingsPage />);
    await screen.findByText("No single sign-on provider is configured yet.");
  });
});
