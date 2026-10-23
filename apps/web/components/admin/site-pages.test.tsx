// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { GalleryPage } from "./site/gallery-page";
import { SiteInvitesPage } from "./site/invites-page";
import { IsolationPage } from "./site/isolation-page";
import { RolesPage } from "./site/roles-page";
import { SettingsPage } from "./site/settings-page";
import { TeamsPage } from "./site/teams-page";
import { UsersPage } from "./site/users-page";
import { forbidNativeConfirm, ME, answerConfirm, renderSite, stubApi, summary } from "./testing";

const user = (id: string, name: string, siteRole: string, deactivatedAt: string | null = null) => ({
  id,
  name,
  email: `${id}@x.io`,
  siteRole,
  twoFactorEnabled: false,
  deactivatedAt,
  createdAt: "2026-10-01T10:00:00.000Z",
});
const USERS = {
  users: [
    user(ME.id, ME.name, "admin"),
    user("u-owner", "Olive", "owner"),
    user("u-admin", "Abe", "admin"),
    user("u-bob", "Bob", "user"),
    user("u-gone", "Gus", "user", "2026-10-01T11:00:00.000Z"),
  ],
};
const forbidden = [
  403,
  { code: "forbidden", message: "You don't have permission to do that." },
] as const;

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Users", () => {
  it("lists users and offers only the deactivations the server allows an Admin", async () => {
    const calls = stubApi({ "GET /v1/site/users": [200, USERS] });
    renderSite(<UsersPage />, "admin");
    await screen.findByRole("table");
    expect(summary(calls)).toEqual(["GET /v1/site/users"]);
    expect(screen.getByRole("button", { name: "Deactivate Bob" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reactivate Gus" })).toBeTruthy();
    // Not yourself, not the Owner, and (as an Admin) not another Admin.
    expect(screen.queryByRole("button", { name: /Ada/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Olive/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Abe/ })).toBeNull();
  });

  it("lets the Owner act on Admins", async () => {
    stubApi({
      "GET /v1/site/users": [
        200,
        { users: [user(ME.id, ME.name, "owner"), user("u-admin", "Abe", "admin")] },
      ],
    });
    renderSite(<UsersPage />, "owner");
    expect(await screen.findByRole("button", { name: "Deactivate Abe" })).toBeTruthy();
  });

  it("deactivates, reports orphaned teams and failed steps, and reloads", async () => {
    const calls = stubApi({
      "GET /v1/site/users": [200, USERS],
      "POST /v1/site/users/u-bob/deactivate": [
        200,
        {
          user_id: "u-bob",
          deactivated: true,
          teamsWithoutActiveAdmin: [{ id: "t", slug: "fin", name: "Finance" }],
          incompleteSteps: ["sandboxes"],
        },
      ],
    });
    renderSite(<UsersPage />);
    const deactivate = await screen.findByRole("button", { name: "Deactivate Bob" });
    await userEvent.click(deactivate);
    expect(summary(calls)).toEqual(["GET /v1/site/users"]);
    const asked = await answerConfirm("Deactivate Bob?", "Deactivate");
    expect(asked).toMatch(/Every session ends now/);
    const status = await screen.findByText(/Bob is deactivated/);
    expect(status.textContent).toMatch(/no active team admin: Finance/);
    expect(status.textContent).toMatch(/sandboxes/);
    await waitFor(() =>
      expect(summary(calls)).toEqual([
        "GET /v1/site/users",
        "POST /v1/site/users/u-bob/deactivate",
        "GET /v1/site/users",
      ]),
    );
    // The button was disabled while the change ran: focus comes back to it, not the page top.
    await waitFor(() => expect(document.activeElement).toBe(deactivate));
  });

  it("does nothing when the confirmation is declined, and returns focus to the button", async () => {
    const calls = stubApi({ "GET /v1/site/users": [200, USERS] });
    renderSite(<UsersPage />);
    const button = await screen.findByRole("button", { name: "Deactivate Bob" });
    await userEvent.click(button);
    await answerConfirm("Deactivate Bob?", "Cancel");
    expect(summary(calls)).toEqual(["GET /v1/site/users"]);
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("asks before reactivating", async () => {
    const calls = stubApi({
      "GET /v1/site/users": [200, USERS],
      "POST /v1/site/users/u-gone/reactivate": [200, { user_id: "u-gone", deactivated: false }],
    });
    renderSite(<UsersPage />);
    const reactivate = await screen.findByRole("button", { name: "Reactivate Gus" });
    await userEvent.click(reactivate);
    await answerConfirm("Reactivate Gus?", "Cancel");
    expect(summary(calls)).toEqual(["GET /v1/site/users"]);
    await userEvent.click(reactivate);
    expect(await answerConfirm("Reactivate Gus?", "Reactivate")).toMatch(/sign in again/);
    await screen.findByText("Gus can sign in again.");
    expect(summary(calls)).toContain("POST /v1/site/users/u-gone/reactivate");
  });

  it("renders a 403 from the API as the answer, whatever the UI showed", async () => {
    stubApi({ "GET /v1/site/users": forbidden });
    renderSite(<UsersPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/don't have permission/);
    expect(alert.textContent).toMatch(/access may have changed/);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the server's refusal of a change", async () => {
    stubApi({
      "GET /v1/site/users": [200, USERS],
      "POST /v1/site/users/u-bob/deactivate": [
        404,
        { code: "user_not_found", message: "No Kobe user with that id." },
      ],
    });
    renderSite(<UsersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate Bob" }));
    await answerConfirm("Deactivate Bob?", "Deactivate");
    expect((await screen.findByRole("alert")).textContent).toMatch(/No Kobe user with that id/);
  });
});

describe("Invitations", () => {
  const INVITES = {
    invitations: [
      {
        id: "i-1",
        email: "new@x.io",
        invitedBy: { id: ME.id, name: ME.name },
        createdAt: "2026-10-01T10:00:00Z",
        expiresAt: "2026-10-04T10:00:00Z",
        status: "pending",
      },
    ],
  };

  it("invites by email and warns when the email couldn't be sent", async () => {
    const calls = stubApi({
      "GET /v1/site/invites": [200, INVITES],
      "POST /v1/site/invites": [
        201,
        { invitation: { id: "i-2", email: "b@x.io", expiresAt: "" }, emailSent: false },
      ],
    });
    renderSite(<SiteInvitesPage />);
    await screen.findByRole("table");
    await userEvent.type(screen.getByLabelText("Email address"), "b@x.io");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect((await screen.findByText(/could not be sent/)).textContent).toMatch(/b@x\.io/);
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({ email: "b@x.io" });
  });

  it("resends and revokes", async () => {
    const calls = stubApi({
      "GET /v1/site/invites": [200, INVITES],
      "POST /v1/site/invites/i-1/resend": [
        200,
        { invitation: { id: "i-1", email: "new@x.io", expiresAt: "" }, emailSent: true },
      ],
      "DELETE /v1/site/invites/i-1": [204],
    });
    renderSite(<SiteInvitesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Resend to new@x.io" }));
    await screen.findByText("Invitation sent to new@x.io.");
    await userEvent.click(screen.getByRole("button", { name: "Revoke invitation to new@x.io" }));
    await answerConfirm("Revoke the invitation to new@x.io?", "Cancel");
    expect(summary(calls)).not.toContain("DELETE /v1/site/invites/i-1");
    await userEvent.click(screen.getByRole("button", { name: "Revoke invitation to new@x.io" }));
    expect(await answerConfirm("Revoke the invitation to new@x.io?", "Revoke")).toMatch(
      /link stops working/,
    );
    await screen.findByText("Revoked the invitation to new@x.io.");
    expect(summary(calls)).toContain("POST /v1/site/invites/i-1/resend");
    expect(summary(calls)).toContain("DELETE /v1/site/invites/i-1");
  });

  it("shows user_exists from the server", async () => {
    stubApi({
      "GET /v1/site/invites": [200, { invitations: [] }],
      "POST /v1/site/invites": [
        409,
        { code: "user_exists", message: "That address already has a Kobe account." },
      ],
    });
    renderSite(<SiteInvitesPage />);
    await screen.findByText("No open invitations.");
    await userEvent.type(screen.getByLabelText("Email address"), "b@x.io");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has a Kobe account/);
  });
});

describe("Site roles", () => {
  const ROLES = {
    roles: [
      { userId: ME.id, name: ME.name, email: ME.email, role: "owner" },
      { userId: "u-admin", name: "Abe", email: "abe@x.io", role: "admin" },
    ],
  };

  it("is read-only for Admins, who still give Skill reviewer (KOBE-331)", async () => {
    stubApi({
      "GET /v1/site/roles": [200, ROLES],
      "GET /v1/site/users": [200, USERS],
      "GET /v1/site/roles/grants": [200, { grants: [] }],
    });
    renderSite(<RolesPage />, "admin");
    await screen.findByRole("table");
    expect(screen.getByText(/Only the Owner grants or revokes Admin/)).toBeTruthy();
    await screen.findByRole("form", { name: "Give Skill reviewer" });
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Make Skill reviewer",
    ]);
    expect(screen.queryByRole("form", { name: "Transfer ownership" })).toBeNull();
  });

  it("lets the Owner grant and revoke Admin", async () => {
    const calls = stubApi({
      "GET /v1/site/roles": [200, ROLES],
      "GET /v1/site/users": [200, USERS],
      "PUT /v1/site/roles/u-admin": [200, { userId: "u-admin", role: "user" }],
      "PUT /v1/site/roles/u-bob": [200, { userId: "u-bob", role: "admin" }],
    });
    renderSite(<RolesPage />, "owner");
    await userEvent.click(await screen.findByRole("button", { name: "Revoke Admin from Abe" }));
    await answerConfirm("Revoke Admin from Abe?", "Cancel");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Revoke Admin from Abe" }));
    expect(await answerConfirm("Revoke Admin from Abe?", "Revoke Admin")).toMatch(/become a User/);
    await screen.findByText("Abe is now a User.");
    const grant = await screen.findByRole("form", { name: "Grant Admin" });
    // Only active plain users are offered.
    const options = within(grant)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Choose a user…", "Bob (u-bob@x.io)"]);
    await userEvent.selectOptions(within(grant).getByLabelText("User"), "u-bob");
    await userEvent.click(within(grant).getByRole("button", { name: "Make Admin" }));
    await screen.findByText("Bob is now an Admin.");
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => [c.url, JSON.parse(String(c.body))])).toEqual([
      ["/v1/site/roles/u-admin", { role: "user" }],
      ["/v1/site/roles/u-bob", { role: "admin" }],
    ]);
  });
  it("asks before transferring ownership and sends nothing when cancelled", async () => {
    const calls = stubApi({
      "GET /v1/site/roles": [200, ROLES],
      "GET /v1/site/users": [200, USERS],
    });
    renderSite(<RolesPage />, "owner");
    const form = await screen.findByRole("form", { name: "Transfer ownership" });
    await userEvent.selectOptions(within(form).getByLabelText("New Owner"), "u-bob");
    await userEvent.click(within(form).getByRole("button", { name: "Transfer ownership" }));
    expect(await answerConfirm("Make Bob the Owner?", "Cancel")).toMatch(/Only they can undo/);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("Teams", () => {
  const TEAMS = {
    teams: [{ id: "t-1", slug: "fin", name: "Finance", createdAt: "2026-10-01T10:00:00Z" }],
  };

  it("creates a team with a suggested slug and its first team admin", async () => {
    const calls = stubApi({
      "GET /v1/site/teams": [200, TEAMS],
      "GET /v1/site/users": [200, USERS],
      "POST /v1/site/teams": [
        201,
        { team: { id: "t-2", slug: "marketing-sales", name: "Marketing & Sales" } },
      ],
    });
    renderSite(<TeamsPage />);
    const form = await screen.findByRole("form", { name: "Create a team" });
    await userEvent.type(within(form).getByLabelText("Name"), "Marketing & Sales");
    expect((within(form).getByLabelText("Slug") as HTMLInputElement).value).toBe("marketing-sales");
    // Deactivated users can't be named first team admin.
    expect(within(form).queryByRole("option", { name: /Gus/ })).toBeNull();
    await userEvent.selectOptions(within(form).getByLabelText("First team admin"), "u-bob");
    await userEvent.click(within(form).getByRole("button", { name: "Create team" }));
    await screen.findByText("Created Marketing & Sales.");
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({
      slug: "marketing-sales",
      name: "Marketing & Sales",
      adminUserId: "u-bob",
    });
  });

  it("shows slug_taken and reads a roster", async () => {
    const calls = stubApi({
      "GET /v1/site/teams": [200, TEAMS],
      "GET /v1/site/users": [200, USERS],
      "POST /v1/site/teams": [
        409,
        { code: "slug_taken", message: "Another team already uses that slug." },
      ],
      "GET /v1/site/teams/t-1/members": [
        200,
        {
          members: [
            { userId: "u-bob", name: "Bob", email: "b@x.io", role: "team_admin", joinedAt: "" },
          ],
        },
      ],
    });
    renderSite(<TeamsPage />);
    const form = await screen.findByRole("form", { name: "Create a team" });
    await userEvent.type(within(form).getByLabelText("Name"), "Finance");
    await userEvent.selectOptions(within(form).getByLabelText("First team admin"), "u-bob");
    await userEvent.click(within(form).getByRole("button", { name: "Create team" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already uses that slug/);
    await userEvent.click(screen.getByRole("button", { name: "Members of Finance" }));
    const roster = await screen.findByRole("list", { name: "Members of Finance" });
    expect(roster.textContent).toMatch(/Bob \(b@x\.io\) · Team admin/);
    expect(summary(calls)).toContain("GET /v1/site/teams/t-1/members");
  });

  it("renames a team", async () => {
    const calls = stubApi({
      "GET /v1/site/teams": [200, TEAMS],
      "GET /v1/site/users": [200, USERS],
      "PATCH /v1/site/teams/t-1": [
        200,
        { team: { id: "t-1", slug: "fin", name: "Finance & Ops" } },
      ],
    });
    renderSite(<TeamsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Rename Finance" }));
    const input = screen.getByLabelText("New name for Finance");
    await userEvent.clear(input);
    await userEvent.type(input, "Finance & Ops");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Renamed to Finance & Ops.");
    const patch = must(calls.find((c) => c.method === "PATCH"));
    expect(JSON.parse(String(patch.body))).toEqual({ name: "Finance & Ops" });
  });
});

describe("Teams: keyboard flow of rename", () => {
  it("moves focus into the form and back, and Cancel discards the edit", async () => {
    stubApi({
      "GET /v1/site/teams": [200, { teams: [{ id: "t-1", slug: "fin", name: "Finance" }] }],
      "GET /v1/site/users": [200, USERS],
    });
    renderSite(<TeamsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Rename Finance" }));
    const input = screen.getByLabelText("New name for Finance");
    expect(document.activeElement).toBe(input);
    await userEvent.type(input, " (old)");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const rename = screen.getByRole("button", { name: "Rename Finance" });
    await waitFor(() => expect(document.activeElement).toBe(rename));
    await userEvent.click(rename);
    expect((screen.getByLabelText("New name for Finance") as HTMLInputElement).value).toBe(
      "Finance",
    );
  });
});

const WEB_SEARCH = {
  configured: false,
  provider: null,
  enabled: false,
  hint: null,
  updatedAt: null,
  providers: [
    { id: "brave", label: "Brave Search", domain: "api.search.brave.com" },
    { id: "tavily", label: "Tavily", domain: "api.tavily.com" },
  ],
};

describe("Web search setting", () => {
  it("saves the provider and key, then shows only the masked hint", async () => {
    const calls = stubApi({
      "GET /v1/site/settings": [200, { requireTwoFactor: false }],
      "GET /v1/site/web-search": [
        [200, WEB_SEARCH],
        [
          200,
          { ...WEB_SEARCH, configured: true, provider: "brave", enabled: true, hint: "••••wxyz" },
        ],
      ],
      "PUT /v1/site/web-search": [
        200,
        { ...WEB_SEARCH, configured: true, provider: "brave", enabled: true, hint: "••••wxyz" },
      ],
    });
    renderSite(<SettingsPage />, "admin");
    await userEvent.selectOptions(await screen.findByLabelText("Search provider"), "brave");
    await userEvent.type(screen.getByLabelText("API key"), "BSA-secret-key-wxyz");
    await userEvent.click(screen.getByRole("button", { name: "Save web search" }));
    await screen.findByText(/Web search is on with Brave Search/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({
      provider: "brave",
      api_key: "BSA-secret-key-wxyz",
      enabled: true,
    });
    await screen.findByText(/••••wxyz/);
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("BSA-secret-key-wxyz");
  });

  it("removes the provider after confirmation", async () => {
    const configured = {
      ...WEB_SEARCH,
      configured: true,
      provider: "brave",
      enabled: true,
      hint: "••••wxyz",
    };
    const calls = stubApi({
      "GET /v1/site/settings": [200, { requireTwoFactor: false }],
      "GET /v1/site/web-search": [
        [200, configured],
        [200, WEB_SEARCH],
      ],
      "DELETE /v1/site/web-search": [204],
    });
    renderSite(<SettingsPage />, "admin");
    await userEvent.click(await screen.findByRole("button", { name: "Remove provider" }));
    await answerConfirm("Remove the web search provider and its key?", "Cancel");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Remove provider" }));
    await answerConfirm("Remove the web search provider and its key?", "Remove provider");
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});

describe("Settings", () => {
  it("doesn't let an Admin turn required 2FA off", async () => {
    stubApi({
      "GET /v1/site/settings": [200, { requireTwoFactor: true }],
      "GET /v1/site/web-search": [200, WEB_SEARCH],
    });
    renderSite(<SettingsPage />, "admin");
    const box = (await screen.findAllByRole("checkbox"))[0] as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(screen.getByText("Only the Owner can turn this off.")).toBeTruthy();
  });

  it("saves the setting", async () => {
    const calls = stubApi({
      "GET /v1/site/settings": [200, { requireTwoFactor: false }],
      "PUT /v1/site/settings": [200, { requireTwoFactor: true }],
      "GET /v1/site/web-search": [200, WEB_SEARCH],
    });
    renderSite(<SettingsPage />, "admin");
    await userEvent.click((await screen.findAllByRole("checkbox"))[0] as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await screen.findByText(/now required/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ requireTwoFactor: true });
  });
});

describe("Isolation", () => {
  const MISSING = {
    state: "missing",
    agents_enabled: false,
    runtime_class_name: "gvisor",
    message: 'RuntimeClass "gvisor" has handler "runc", which is not gVisor or Kata.',
    checked_at: "2026-10-01T10:00:00Z",
    docs: "docs/install.md#isolation",
  };

  it("shows the fix when the runtime is missing, and re-checks", async () => {
    const calls = stubApi({
      "GET /v1/site/isolation": [200, MISSING],
      "POST /v1/site/isolation/check": [
        200,
        {
          state: "verified",
          agentsEnabled: true,
          runtimeClassName: "gvisor",
          handler: "runsc",
          checkedAt: "2026-10-01T10:01:00Z",
        },
      ],
    });
    renderSite(<IsolationPage />);
    const fix = await screen.findByRole("region", { name: /isolation runtime missing/ });
    expect(fix.textContent).toMatch(/handler "runc"/);
    expect(fix.textContent).toMatch(/install-gvisor-k3s\.sh/);
    expect(fix.textContent).toMatch(/docs\/install\.md#isolation/);
    const details = screen.getByLabelText("Isolation status");
    expect(details.textContent).toMatch(/Runtime checkMissing.*AgentsDisabled.*RuntimeClassgvisor/);
    await userEvent.click(screen.getByRole("button", { name: "Re-check now" }));
    await screen.findByText("Isolation verified: agents are enabled.");
    expect(screen.queryByRole("region", { name: /isolation runtime missing/ })).toBeNull();
    expect(screen.getByText("runsc")).toBeTruthy();
    expect(summary(calls)).toEqual(["GET /v1/site/isolation", "POST /v1/site/isolation/check"]);
  });

  it("reports a server without the isolation route", async () => {
    stubApi({});
    renderSite(<IsolationPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/unrouted|not found/i);
  });
});

describe("Gallery agents", () => {
  const AGENTS = {
    agents: [
      {
        id: "a-1",
        scope: "gallery",
        slug: "kobe",
        name: "Kobe",
        status: "active",
        ownerUserId: null,
        currentVersion: null,
        revision: 1,
        updatedAt: "2026-10-01T10:00:00Z",
        canEdit: true,
        starters: [],
      },
    ],
  };

  const SCORES = {
    scores: [
      {
        agentId: "a-1",
        version: 1,
        status: "blocked",
        attackSuccessRate: 0.6,
        attempts: 5,
        threshold: 0.2,
        evaluatedAt: "2026-10-04T09:30:00Z",
      },
    ],
  };
  const MY_TEAMS = {
    activeTeamId: null,
    teams: [
      { id: "t-1", slug: "finance", name: "Finance", role: "team_admin" },
      { id: "t-2", slug: "ops", name: "Ops", role: "member" },
    ],
  };

  it("lists and exports, and links each agent to its editor (KOBE-494)", async () => {
    stubApi({ "GET /v1/site/gallery/agents": [200, AGENTS] });
    renderSite(<GalleryPage />);
    const exportLink = await screen.findByRole("link", { name: "Export Kobe" });
    expect(exportLink.getAttribute("href")).toBe("/v1/site/gallery/agents/a-1/export");
    const edit = screen.getByRole("link", { name: "Edit Kobe" });
    expect(edit.getAttribute("href")).toBe("/admin/site/gallery/a-1");
    expect(screen.queryByText("Customized")).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete|Save|Reset/ })).toBeNull();
  });

  it("offers no Edit for an archived agent or without the right", async () => {
    const agents = {
      agents: [
        { ...AGENTS.agents[0], archivedAt: "2026-10-02T10:00:00Z" },
        { ...AGENTS.agents[0], id: "a-2", name: "Other", slug: "other", canEdit: false },
      ],
    };
    stubApi({ "GET /v1/site/gallery/agents": [200, agents] });
    renderSite(<GalleryPage />);
    await screen.findByRole("link", { name: "Export Kobe" });
    expect(screen.queryByRole("link", { name: /^Edit/ })).toBeNull();
  });

  const CUSTOMIZED = {
    key: "kobe",
    generation: 3,
    customized: true,
    customized_at: "2026-10-23T09:00:00Z",
    customized_by: "u-me",
    customized_from_generation: 2,
    update_available: true,
  };

  it("badges a customized agent and offers Compare and Reset when the repository moved on", async () => {
    forbidNativeConfirm();
    const customized = {
      agents: [{ ...AGENTS.agents[0], currentVersion: 4, gallery: CUSTOMIZED }],
    };
    const reset = {
      agent: {
        ...AGENTS.agents[0],
        frontmatter: { name: "Kobe" },
        prompt: "Repo.",
        gallery: { ...CUSTOMIZED, customized: false, update_available: false },
      },
    };
    const calls = stubApi({
      "GET /v1/site/gallery/agents": [
        [200, customized],
        [200, { agents: [{ ...AGENTS.agents[0], currentVersion: 5 }] }],
      ],
      "GET /v1/site/gallery/agents/a-1/compare": [
        200,
        {
          gallery: CUSTOMIZED,
          repository: { generation: 3, frontmatter: {}, prompt: "Repo.", file: "repo file" },
          current: { version: 4, frontmatter: {}, prompt: "Mine.", file: "my file" },
        },
      ],
      "POST /v1/site/gallery/agents/a-1/reset": [200, reset],
    });
    renderSite(<GalleryPage />);
    expect(await screen.findByText("Customized")).toBeTruthy();
    expect(screen.getByText(/A newer repository version of Kobe is available/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Compare Kobe with the repository" }));
    expect(await screen.findByText("repo file")).toBeTruthy();
    expect(screen.getByText("my file")).toBeTruthy();
    expect(screen.getByText("Repository definition (generation 3)")).toBeTruthy();
    expect(screen.getByText("Current version (v4)")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reset to repository (Kobe)" }));
    // Asks first: Cancel sends nothing.
    await answerConfirm("Reset Kobe to the repository definition?", "Cancel");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Reset to repository (Kobe)" }));
    await answerConfirm("Reset Kobe to the repository definition?", "Reset to repository");
    await waitFor(() => expect(screen.queryByText("Customized")).toBeNull());
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      "/v1/site/gallery/agents/a-1/reset",
    ]);
  });

  it("shows no notice for a customized agent the repository has not moved past", async () => {
    stubApi({
      "GET /v1/site/gallery/agents": [
        200,
        {
          agents: [
            {
              ...AGENTS.agents[0],
              gallery: { ...CUSTOMIZED, generation: 2, update_available: false },
            },
          ],
        },
      ],
    });
    renderSite(<GalleryPage />);
    expect(await screen.findByText("Customized")).toBeTruthy();
    expect(screen.queryByText(/A newer repository version/)).toBeNull();
  });

  it("shows the published score and starts an eval in the chosen team", async () => {
    const published = { agents: [{ ...AGENTS.agents[0], currentVersion: 1 }] };
    const calls = stubApi({
      "GET /v1/site/gallery/agents": [200, published],
      "GET /v1/site/gallery/agents/scores": [200, SCORES],
      "GET /v1/me/teams": [200, MY_TEAMS],
      "POST /v1/site/gallery/agents/a-1/eval": [202, { message: "Evaluating" }],
    });
    renderSite(<GalleryPage />);
    expect(await screen.findByText("60% attacks succeeded (blocked)")).toBeTruthy();
    await userEvent.selectOptions(await screen.findByLabelText("Run evals in team"), "t-2");
    await userEvent.click(screen.getByRole("button", { name: "Run eval for Kobe" }));
    await screen.findByText("Evaluating Kobe. The score appears here when it finishes.");
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({ teamId: "t-2" });
  });

  it("says when the gallery is empty", async () => {
    stubApi({ "GET /v1/site/gallery/agents": [200, { agents: [] }] });
    renderSite(<GalleryPage />);
    await screen.findByText("The gallery is empty.");
  });
});
