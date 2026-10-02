// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { GalleryPage } from "./install/gallery-page";
import { InstallInvitesPage } from "./install/invites-page";
import { IsolationPage } from "./install/isolation-page";
import { RolesPage } from "./install/roles-page";
import { SettingsPage } from "./install/settings-page";
import { TeamsPage } from "./install/teams-page";
import { UsersPage } from "./install/users-page";
import { ME, renderInstall, stubApi, summary } from "./testing";

const user = (
  id: string,
  name: string,
  installRole: string,
  deactivatedAt: string | null = null,
) => ({
  id,
  name,
  email: `${id}@x.io`,
  installRole,
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

beforeEach(() => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Users", () => {
  it("lists users and offers only the deactivations the server allows an Admin", async () => {
    const calls = stubApi({ "GET /v1/install/users": [200, USERS] });
    renderInstall(<UsersPage />, "admin");
    await screen.findByRole("table");
    expect(summary(calls)).toEqual(["GET /v1/install/users"]);
    expect(screen.getByRole("button", { name: "Deactivate Bob" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reactivate Gus" })).toBeTruthy();
    // Not yourself, not the Owner, and (as an Admin) not another Admin.
    expect(screen.queryByRole("button", { name: /Ada/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Olive/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Abe/ })).toBeNull();
  });

  it("lets the Owner act on Admins", async () => {
    stubApi({
      "GET /v1/install/users": [
        200,
        { users: [user(ME.id, ME.name, "owner"), user("u-admin", "Abe", "admin")] },
      ],
    });
    renderInstall(<UsersPage />, "owner");
    expect(await screen.findByRole("button", { name: "Deactivate Abe" })).toBeTruthy();
  });

  it("deactivates, reports orphaned teams and failed steps, and reloads", async () => {
    const calls = stubApi({
      "GET /v1/install/users": [200, USERS],
      "POST /v1/install/users/u-bob/deactivate": [
        200,
        {
          user_id: "u-bob",
          deactivated: true,
          teamsWithoutActiveAdmin: [{ id: "t", slug: "fin", name: "Finance" }],
          incompleteSteps: ["sandboxes"],
        },
      ],
    });
    renderInstall(<UsersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate Bob" }));
    const status = await screen.findByText(/Bob is deactivated/);
    expect(status.textContent).toMatch(/no active team admin: Finance/);
    expect(status.textContent).toMatch(/sandboxes/);
    await waitFor(() =>
      expect(summary(calls)).toEqual([
        "GET /v1/install/users",
        "POST /v1/install/users/u-bob/deactivate",
        "GET /v1/install/users",
      ]),
    );
  });

  it("does nothing when the confirmation is declined", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const calls = stubApi({ "GET /v1/install/users": [200, USERS] });
    renderInstall(<UsersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate Bob" }));
    expect(summary(calls)).toEqual(["GET /v1/install/users"]);
  });

  it("renders a 403 from the API as the answer, whatever the UI showed", async () => {
    stubApi({ "GET /v1/install/users": forbidden });
    renderInstall(<UsersPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/don't have permission/);
    expect(alert.textContent).toMatch(/access may have changed/);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the server's refusal of a change", async () => {
    stubApi({
      "GET /v1/install/users": [200, USERS],
      "POST /v1/install/users/u-bob/deactivate": [
        404,
        { code: "user_not_found", message: "No Kobe user with that id." },
      ],
    });
    renderInstall(<UsersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate Bob" }));
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
      "GET /v1/install/invites": [200, INVITES],
      "POST /v1/install/invites": [
        201,
        { invitation: { id: "i-2", email: "b@x.io", expiresAt: "" }, emailSent: false },
      ],
    });
    renderInstall(<InstallInvitesPage />);
    await screen.findByRole("table");
    await userEvent.type(screen.getByLabelText("Email address"), "b@x.io");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect((await screen.findByText(/could not be sent/)).textContent).toMatch(/b@x\.io/);
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({ email: "b@x.io" });
  });

  it("resends and revokes", async () => {
    const calls = stubApi({
      "GET /v1/install/invites": [200, INVITES],
      "POST /v1/install/invites/i-1/resend": [
        200,
        { invitation: { id: "i-1", email: "new@x.io", expiresAt: "" }, emailSent: true },
      ],
      "DELETE /v1/install/invites/i-1": [204],
    });
    renderInstall(<InstallInvitesPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Resend to new@x.io" }));
    await screen.findByText("Invitation sent to new@x.io.");
    await userEvent.click(screen.getByRole("button", { name: "Revoke invitation to new@x.io" }));
    await screen.findByText("Revoked the invitation to new@x.io.");
    expect(summary(calls)).toContain("POST /v1/install/invites/i-1/resend");
    expect(summary(calls)).toContain("DELETE /v1/install/invites/i-1");
  });

  it("shows user_exists from the server", async () => {
    stubApi({
      "GET /v1/install/invites": [200, { invitations: [] }],
      "POST /v1/install/invites": [
        409,
        { code: "user_exists", message: "That address already has a Kobe account." },
      ],
    });
    renderInstall(<InstallInvitesPage />);
    await screen.findByText("No open invitations.");
    await userEvent.type(screen.getByLabelText("Email address"), "b@x.io");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has a Kobe account/);
  });
});

describe("Install roles", () => {
  const ROLES = {
    roles: [
      { userId: ME.id, name: ME.name, email: ME.email, role: "owner" },
      { userId: "u-admin", name: "Abe", email: "abe@x.io", role: "admin" },
    ],
  };

  it("is read-only for Admins", async () => {
    stubApi({ "GET /v1/install/roles": [200, ROLES], "GET /v1/install/users": [200, USERS] });
    renderInstall(<RolesPage />, "admin");
    await screen.findByRole("table");
    expect(screen.getByText(/Only the Owner grants or revokes Admin/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("form", { name: "Transfer ownership" })).toBeNull();
  });

  it("lets the Owner grant and revoke Admin", async () => {
    const calls = stubApi({
      "GET /v1/install/roles": [200, ROLES],
      "GET /v1/install/users": [200, USERS],
      "PUT /v1/install/roles/u-admin": [200, { userId: "u-admin", role: "user" }],
      "PUT /v1/install/roles/u-bob": [200, { userId: "u-bob", role: "admin" }],
    });
    renderInstall(<RolesPage />, "owner");
    await userEvent.click(await screen.findByRole("button", { name: "Revoke Admin from Abe" }));
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
      ["/v1/install/roles/u-admin", { role: "user" }],
      ["/v1/install/roles/u-bob", { role: "admin" }],
    ]);
  });
});

describe("Teams", () => {
  const TEAMS = {
    teams: [{ id: "t-1", slug: "fin", name: "Finance", createdAt: "2026-10-01T10:00:00Z" }],
  };

  it("creates a team with a suggested slug and its first team admin", async () => {
    const calls = stubApi({
      "GET /v1/install/teams": [200, TEAMS],
      "GET /v1/install/users": [200, USERS],
      "POST /v1/install/teams": [
        201,
        { team: { id: "t-2", slug: "marketing-sales", name: "Marketing & Sales" } },
      ],
    });
    renderInstall(<TeamsPage />);
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
      "GET /v1/install/teams": [200, TEAMS],
      "GET /v1/install/users": [200, USERS],
      "POST /v1/install/teams": [
        409,
        { code: "slug_taken", message: "Another team already uses that slug." },
      ],
      "GET /v1/install/teams/t-1/members": [
        200,
        {
          members: [
            { userId: "u-bob", name: "Bob", email: "b@x.io", role: "team_admin", joinedAt: "" },
          ],
        },
      ],
    });
    renderInstall(<TeamsPage />);
    const form = await screen.findByRole("form", { name: "Create a team" });
    await userEvent.type(within(form).getByLabelText("Name"), "Finance");
    await userEvent.selectOptions(within(form).getByLabelText("First team admin"), "u-bob");
    await userEvent.click(within(form).getByRole("button", { name: "Create team" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already uses that slug/);
    await userEvent.click(screen.getByRole("button", { name: "Members of Finance" }));
    const roster = await screen.findByRole("list", { name: "Members of Finance" });
    expect(roster.textContent).toMatch(/Bob \(b@x\.io\) · Team admin/);
    expect(summary(calls)).toContain("GET /v1/install/teams/t-1/members");
  });

  it("renames a team", async () => {
    const calls = stubApi({
      "GET /v1/install/teams": [200, TEAMS],
      "GET /v1/install/users": [200, USERS],
      "PATCH /v1/install/teams/t-1": [
        200,
        { team: { id: "t-1", slug: "fin", name: "Finance & Ops" } },
      ],
    });
    renderInstall(<TeamsPage />);
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
      "GET /v1/install/teams": [200, { teams: [{ id: "t-1", slug: "fin", name: "Finance" }] }],
      "GET /v1/install/users": [200, USERS],
    });
    renderInstall(<TeamsPage />);
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

describe("Settings", () => {
  it("doesn't let an Admin turn required 2FA off", async () => {
    stubApi({ "GET /v1/install/settings": [200, { requireTwoFactor: true }] });
    renderInstall(<SettingsPage />, "admin");
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(screen.getByText("Only the Owner can turn this off.")).toBeTruthy();
  });

  it("saves the setting", async () => {
    const calls = stubApi({
      "GET /v1/install/settings": [200, { requireTwoFactor: false }],
      "PUT /v1/install/settings": [200, { requireTwoFactor: true }],
    });
    renderInstall(<SettingsPage />, "admin");
    await userEvent.click(await screen.findByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
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
      "GET /v1/install/isolation": [200, MISSING],
      "POST /v1/install/isolation/check": [
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
    renderInstall(<IsolationPage />);
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
    expect(summary(calls)).toEqual([
      "GET /v1/install/isolation",
      "POST /v1/install/isolation/check",
    ]);
  });

  it("reports a server without the isolation route", async () => {
    stubApi({});
    renderInstall(<IsolationPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/unrouted|not found/i);
  });
});

describe("Gallery agents", () => {
  const AGENTS = {
    agents: [
      {
        id: "a-1",
        scope: "gallery",
        slug: "assistant",
        name: "Assistant",
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

  it("lists, exports, suspends and deletes", async () => {
    const calls = stubApi({
      "GET /v1/install/gallery/agents": [200, AGENTS],
      "PUT /v1/install/gallery/agents/a-1/status": [
        200,
        { agent: { ...AGENTS.agents[0], status: "suspended" } },
      ],
      "DELETE /v1/install/gallery/agents/a-1": [204],
    });
    renderInstall(<GalleryPage />);
    const exportLink = await screen.findByRole("link", { name: "Export Assistant" });
    expect(exportLink.getAttribute("href")).toBe("/v1/install/gallery/agents/a-1/export");
    await userEvent.click(screen.getByRole("button", { name: "Suspend Assistant" }));
    await screen.findByText("Assistant is suspended.");
    await userEvent.click(screen.getByRole("button", { name: "Delete Assistant" }));
    await screen.findByText("Deleted Assistant.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ status: "suspended" });
    expect(summary(calls)).toContain("DELETE /v1/install/gallery/agents/a-1");
  });

  it("imports an agent file as markdown", async () => {
    const calls = stubApi({
      "GET /v1/install/gallery/agents": [200, { agents: [] }],
      "POST /v1/install/gallery/agents": [
        201,
        { agent: { ...AGENTS.agents[0], name: "Helper" }, warnings: [{ code: "auto" }] },
      ],
    });
    renderInstall(<GalleryPage />);
    await screen.findByText("The gallery is empty.");
    const file = new File(["---\nname: Helper\n---\nBe helpful.\n"], "helper.md", {
      type: "text/markdown",
    });
    await userEvent.upload(screen.getByLabelText("Agent file (.md)"), file);
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText(/Imported Helper with 1 warning/);
    const post = must(calls.find((c) => c.method === "POST"));
    expect(post.headers.get("content-type")).toMatch(/^text\/markdown/);
    expect(post.body).toBe("---\nname: Helper\n---\nBe helpful.\n");
  });

  it("shows the server's validation error", async () => {
    stubApi({
      "GET /v1/install/gallery/agents": [200, { agents: [] }],
      "POST /v1/install/gallery/agents": [
        400,
        { code: "invalid_agent", message: "frontmatter.name is required" },
      ],
    });
    renderInstall(<GalleryPage />);
    await screen.findByText("The gallery is empty.");
    await userEvent.upload(screen.getByLabelText("Agent file (.md)"), new File(["nope"], "x.md"));
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/name is required/);
  });
});
