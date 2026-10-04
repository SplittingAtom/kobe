// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { TeamAgentsPage } from "./team/agents-page";
import { TeamInvitesPage } from "./team/invites-page";
import { MembersPage } from "./team/members-page";
import { ME, TEAM, renderTeam, stubApi, summary } from "./testing";

const MEMBERS = {
  members: [
    {
      userId: ME.id,
      name: ME.name,
      email: ME.email,
      role: "team_admin",
      joinedAt: "2026-10-01T10:00:00Z",
    },
    {
      userId: "u-bob",
      name: "Bob",
      email: "b@x.io",
      role: "member",
      joinedAt: "2026-10-01T10:00:00Z",
    },
  ],
};
const AGENTS = {
  agents: [
    {
      id: "a-1",
      scope: "team",
      slug: "triage",
      name: "Triage",
      status: "active",
      ownerUserId: "u-bob",
      currentVersion: 2,
      revision: 3,
      updatedAt: "2026-10-01T10:00:00Z",
      canEdit: true,
      starters: [],
    },
  ],
};

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign, reload: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Members and roles", () => {
  it("names the active team on every call (reads included)", async () => {
    const calls = stubApi({
      "GET /v1/team/members": [200, MEMBERS],
      "PATCH /v1/team/members/u-bob": [200, { userId: "u-bob", role: "builder" }],
    });
    renderTeam(<MembersPage />);
    await userEvent.selectOptions(await screen.findByLabelText("Role of Bob"), "builder");
    // Choosing alone changes nothing (keyboard users arrow through options).
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Save role of Bob" }));
    await screen.findByText("Bob is now Builder.");
    const patch = must(calls.find((c) => c.method === "PATCH"));
    expect(JSON.parse(String(patch.body))).toEqual({ role: "builder" });
    expect(calls.every((c) => c.headers.get("x-kobe-team") === TEAM.id)).toBe(true);
    await waitFor(() =>
      expect(summary(calls).filter((c) => c === "GET /v1/team/members")).toHaveLength(2),
    );
  });

  it("shows the last-team-admin refusal and resets the list", async () => {
    const calls = stubApi({
      "GET /v1/team/members": [200, MEMBERS],
      [`PATCH /v1/team/members/${ME.id}`]: [
        409,
        {
          code: "last_team_admin",
          message: "A team needs at least one team admin. Promote someone else first.",
        },
      ],
    });
    renderTeam(<MembersPage />);
    await userEvent.selectOptions(await screen.findByLabelText("Role of Ada"), "member");
    await userEvent.click(screen.getByRole("button", { name: "Save role of Ada" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/at least one team admin/);
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect(summary(calls).filter((c) => c.startsWith("GET"))).toHaveLength(2));
    // The refused choice is undone in the row.
    await waitFor(() =>
      expect((screen.getByLabelText("Role of Ada") as HTMLSelectElement).value).toBe("team_admin"),
    );
  });

  it("removes a member after confirmation", async () => {
    const calls = stubApi({
      "GET /v1/team/members": [200, MEMBERS],
      "DELETE /v1/team/members/u-bob": [204],
    });
    renderTeam(<MembersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove Bob" }));
    await screen.findByText("Bob was removed from the team.");
    expect(summary(calls)).toContain("DELETE /v1/team/members/u-bob");
  });

  it("sends you home after leaving the team", async () => {
    stubApi({
      "GET /v1/team/members": [200, MEMBERS],
      [`DELETE /v1/team/members/${ME.id}`]: [204],
    });
    renderTeam(<MembersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Leave team Ada" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  it("offers a reload when another tab switched teams (409 team_mismatch)", async () => {
    stubApi({
      "GET /v1/team/members": [
        409,
        {
          code: "team_mismatch",
          message: "Your active team changed in another tab. Reload to continue.",
        },
      ],
    });
    renderTeam(<MembersPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/another tab/);
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("renders 403 not_a_team_member", async () => {
    stubApi({
      "GET /v1/team/members": [
        403,
        { code: "not_a_team_member", message: "You are no longer a member of this team." },
      ],
    });
    renderTeam(<MembersPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/no longer a member/);
  });
});

describe("Team invitations", () => {
  it("invites with a role and never says whether the address has an account", async () => {
    const calls = stubApi({
      "GET /v1/team/invites": [200, { invitations: [] }],
      "POST /v1/team/invites": [
        202,
        { invitation: { id: "i-1", email: "c@x.io", role: "builder" } },
      ],
    });
    renderTeam(<TeamInvitesPage />);
    await screen.findByText("No open invitations.");
    await userEvent.type(screen.getByLabelText("Email address"), "c@x.io");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "builder");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    const notice = await screen.findByText(/Invited c@x\.io as Builder/);
    expect(notice.textContent).not.toMatch(/account/);
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({ email: "c@x.io", role: "builder" });
    expect(post.headers.get("x-kobe-team")).toBe(TEAM.id);
  });

  it("revokes", async () => {
    const calls = stubApi({
      "GET /v1/team/invites": [
        200,
        {
          invitations: [
            {
              id: "i-1",
              email: "c@x.io",
              role: "member",
              invitedBy: { id: ME.id, name: ME.name },
              createdAt: "",
              expiresAt: "",
              status: "pending",
            },
          ],
        },
      ],
      "DELETE /v1/team/invites/i-1": [204],
    });
    renderTeam(<TeamInvitesPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Revoke invitation to c@x.io" }),
    );
    await screen.findByText("Revoked the invitation to c@x.io.");
    expect(summary(calls)).toContain("DELETE /v1/team/invites/i-1");
  });
});

const item = (over: Record<string, unknown>) => ({
  id: "a-1",
  scope: "team",
  slug: "triage",
  name: "Triage",
  ownerUserId: "u-bob",
  ownerName: "Bob",
  status: "active",
  archivedAt: null,
  currentVersion: 2,
  versionCount: 2,
  runCount: 7,
  lastRunAt: "2026-10-02T10:00:00Z",
  tokens: 1234,
  schedules: null,
  orbitScore: null,
  canExport: true,
  ...over,
});
const INVENTORY_1 = {
  agents: [item({}), item({ id: "p-1", scope: "personal", slug: "mine", name: "Mine" })],
  nextCursor: "mine:00000000-0000-0000-0000-000000000001",
};
const INVENTORY_2 = {
  agents: [item({ id: "p-2", scope: "personal", slug: "zed", name: "Zed", ownerName: "Zoe" })],
  nextCursor: null,
};
const LIST = "GET /v1/agents?scope=team&include_archived=true";

describe("Agent inventory", () => {
  it("shows owner, scope, status, versions, usage and placeholders, and pages", async () => {
    const calls = stubApi({
      [LIST]: [200, AGENTS],
      "GET /v1/agents/inventory": [200, INVENTORY_1],
      "GET /v1/agents/inventory?cursor=mine%3A00000000-0000-0000-0000-000000000001": [
        200,
        INVENTORY_2,
      ],
    });
    renderTeam(<TeamAgentsPage />);
    const row = (await screen.findByRole("row", { name: /Mine/ })) as HTMLElement;
    expect(row.textContent).toMatch(/Bob/);
    expect(row.textContent).toMatch(/Personal/);
    expect(row.textContent).toMatch(/Active/);
    expect(row.textContent).toMatch(/v2/);
    expect(row.textContent).toMatch(/7/);
    expect(row.textContent).toMatch(/1,234/);
    expect(row.textContent?.match(/—/g)?.length).toBe(2);
    expect(row.textContent).not.toMatch(/\$/);
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("row", { name: /Zed/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(summary(calls)).toContain(
      "GET /v1/agents/inventory?cursor=mine%3A00000000-0000-0000-0000-000000000001",
    );
  });

  it("suspends and reactivates any listed agent, personal ones included", async () => {
    const calls = stubApi({
      [LIST]: [200, AGENTS],
      "GET /v1/agents/inventory": [200, { ...INVENTORY_1, nextCursor: null }],
      "PUT /v1/agents/inventory/p-1/status": [
        200,
        { id: "p-1", scope: "personal", status: "suspended" },
      ],
    });
    renderTeam(<TeamAgentsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Suspend Mine" }));
    await screen.findByText("Mine is suspended.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ status: "suspended" });
    expect(put.headers.get("x-kobe-team")).toBe(TEAM.id);
    expect(screen.getByRole("button", { name: "Reactivate Mine" })).toBeTruthy();
  });

  it("offers Export to Orbit only for published agents the caller may export", async () => {
    const calls = stubApi({
      [LIST]: [200, AGENTS],
      "GET /v1/agents/inventory": [
        200,
        {
          nextCursor: null,
          agents: [
            item({}),
            item({ id: "d-1", slug: "draft", name: "Draft", currentVersion: null }),
            item({ id: "p-1", scope: "personal", slug: "mine", name: "Mine", canExport: false }),
            item({ id: "o-1", slug: "old", name: "Old", ownerName: "Zoe" }),
          ],
        },
      ],
    });
    const downloads = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
    );
    const api = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url === "/v1/agents/a-1/versions/2/orbit" ? new Response("name: x\n") : api(url, init),
      ),
    );
    renderTeam(<TeamAgentsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Export Triage to Orbit" }));
    await waitFor(() => expect(downloads).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Export Draft to Orbit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export Mine to Orbit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Export Old to Orbit" })).toBeTruthy();
    expect(summary(calls)).not.toContain("GET /v1/agents/d-1/versions/null/orbit");
  });

  it("is not requested without the suspend permission", async () => {
    const calls = stubApi({ [LIST]: [200, AGENTS] });
    renderTeam(<TeamAgentsPage />, { role: "builder", permissions: ["team.agents.build"] });
    expect(await screen.findByText("v2")).toBeTruthy();
    expect(summary(calls).some((c) => c.includes("inventory"))).toBe(false);
  });

  it("shows the server's refusal of a suspension", async () => {
    stubApi({
      [LIST]: [200, AGENTS],
      "GET /v1/agents/inventory": [200, { ...INVENTORY_1, nextCursor: null }],
      "PUT /v1/agents/inventory/a-1/status": [
        403,
        { code: "forbidden", message: "Only team admins suspend agents." },
      ],
    });
    renderTeam(<TeamAgentsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Suspend Triage" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Only team admins suspend/);
  });
});

describe("Team agents", () => {
  it("lists the team's agents with their builder links", async () => {
    stubApi({
      [LIST]: [200, AGENTS],
      "GET /v1/agents/inventory": [200, { agents: [], nextCursor: null }],
    });
    renderTeam(<TeamAgentsPage />);
    expect(await screen.findByText("v2")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit Triage" })).toBeTruthy();
  });

  it("lets a builder open agents but offers no suspend button", async () => {
    stubApi({ "GET /v1/agents?scope=team&include_archived=true": [200, AGENTS] });
    renderTeam(<TeamAgentsPage />, { role: "builder", permissions: ["team.agents.build"] });
    expect(await screen.findByText("v2")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit Triage" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Suspend/ })).toBeNull();
  });

  it("explains 503 isolation_runtime_missing and links to the fix", async () => {
    stubApi({
      "GET /v1/agents/inventory": [200, { agents: [], nextCursor: null }],
      "GET /v1/agents?scope=team&include_archived=true": [
        503,
        {
          code: "isolation_runtime_missing",
          message:
            "Isolation runtime missing: agents are disabled until an install admin fixes the cluster's gVisor or Kata runtime.",
        },
      ],
    });
    renderTeam(<TeamAgentsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Isolation runtime missing/);
    expect(screen.getByRole("link", { name: "Isolation" }).getAttribute("href")).toBe(
      "/admin/install/isolation",
    );
  });

  it("hides internals of other 5xx answers", async () => {
    stubApi({
      "GET /v1/agents/inventory": [200, { agents: [], nextCursor: null }],
      "GET /v1/agents?scope=team&include_archived=true": [
        500,
        { code: "boom", message: "relation team_agents does not exist" },
      ],
    });
    renderTeam(<TeamAgentsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/HTTP 500/);
    expect(alert.textContent).not.toMatch(/relation/);
  });
});
