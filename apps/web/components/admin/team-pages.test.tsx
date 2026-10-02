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

describe("Team agents", () => {
  it("lists the team's agents and suspends one", async () => {
    const calls = stubApi({
      "GET /v1/agents?scope=team&include_archived=true": [200, AGENTS],
      "PUT /v1/agents/a-1/status": [200, { agent: { ...AGENTS.agents[0], status: "suspended" } }],
    });
    renderTeam(<TeamAgentsPage />);
    expect(await screen.findByText("v2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Suspend Triage" }));
    await screen.findByText("Triage is suspended.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ status: "suspended" });
    expect(put.headers.get("x-kobe-team")).toBe(TEAM.id);
  });

  it("shows the server's refusal (403) of a suspension", async () => {
    stubApi({
      "GET /v1/agents?scope=team&include_archived=true": [200, AGENTS],
      "PUT /v1/agents/a-1/status": [
        403,
        { code: "forbidden", message: "Only team admins suspend team agents." },
      ],
    });
    renderTeam(<TeamAgentsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Suspend Triage" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Only team admins suspend/);
  });

  it("explains 503 isolation_runtime_missing and links to the fix", async () => {
    stubApi({
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
