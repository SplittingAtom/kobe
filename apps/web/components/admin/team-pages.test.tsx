// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { TeamInvitesPage } from "./team/invites-page";
import { ADDED_BY_GRANT, MembersPage } from "./team/members-page";
import {
  forbidNativeConfirm,
  ME,
  TEAM,
  answerConfirm,
  renderTeam,
  stubApi,
  summary,
} from "./testing";

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
let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  forbidNativeConfirm();
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign, reload: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Members and roles", () => {
  it("marks a member Kobe added for the Skill reviewer grant (KOBE-331 review)", async () => {
    stubApi({
      "GET /v1/team/members": [
        200,
        {
          members: [
            MEMBERS.members[0],
            { ...MEMBERS.members[1], addedVia: "skill_reviewer_grant" },
          ],
        },
      ],
    });
    renderTeam(<MembersPage />);
    const row = (await screen.findByText(ADDED_BY_GRANT)).closest("tr");
    expect(row?.textContent).toContain("b@x.io");
    expect(screen.getAllByText(ADDED_BY_GRANT)).toHaveLength(1);
  });

  it("names the active team on every call (reads included)", async () => {
    const calls = stubApi({
      "GET /v1/team/members": [200, MEMBERS],
      "PATCH /v1/team/members/u-bob": [200, { userId: "u-bob", role: "contributor" }],
    });
    renderTeam(<MembersPage />);
    await userEvent.selectOptions(await screen.findByLabelText("Role of Bob"), "contributor");
    // Choosing alone changes nothing (keyboard users arrow through options).
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Save role of Bob" }));
    await screen.findByText("Bob is now Contributor.");
    const patch = must(calls.find((c) => c.method === "PATCH"));
    expect(JSON.parse(String(patch.body))).toEqual({ role: "contributor" });
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
    await answerConfirm("Change your own role?", "Change my role");
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
    expect(summary(calls)).not.toContain("DELETE /v1/team/members/u-bob");
    await answerConfirm("Remove Bob from Finance?", "Remove Bob");
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
    await answerConfirm("Leave Finance?", "Leave team");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  it("keeps your role when you cancel changing it, and keeps a member when removal is cancelled", async () => {
    const calls = stubApi({ "GET /v1/team/members": [200, MEMBERS] });
    renderTeam(<MembersPage />);
    await userEvent.selectOptions(await screen.findByLabelText("Role of Ada"), "member");
    await userEvent.click(screen.getByRole("button", { name: "Save role of Ada" }));
    await answerConfirm("Change your own role?", "Cancel");
    await userEvent.click(screen.getByRole("button", { name: "Remove Bob" }));
    await answerConfirm("Remove Bob from Finance?", "Cancel");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    // Focus goes back to the control that asked.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Bob" }));
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
        { invitation: { id: "i-1", email: "c@x.io", role: "contributor" } },
      ],
    });
    renderTeam(<TeamInvitesPage />);
    await screen.findByText("No open invitations.");
    await userEvent.type(screen.getByLabelText(/Email address/), "c@x.io");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "contributor");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    const notice = await screen.findByText(/Invited c@x\.io as Contributor/);
    expect(notice.textContent).not.toMatch(/account/);
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({ email: "c@x.io", role: "contributor" });
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
    // A confirm dialog (KOBE-294): nothing is revoked until the person confirms.
    const dialog = await screen.findByRole("alertdialog", {
      name: "Revoke the invitation to c@x.io?",
    });
    expect(summary(calls)).not.toContain("DELETE /v1/team/invites/i-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await screen.findByText("Revoked the invitation to c@x.io.");
    expect(summary(calls)).toContain("DELETE /v1/team/invites/i-1");
  });

  it("keeps the invitation when the revoke is cancelled", async () => {
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
    });
    renderTeam(<TeamInvitesPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Revoke invitation to c@x.io" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(summary(calls)).toEqual(["GET /v1/team/invites"]);
  });
});

const invite = (id: string, email: string, status = "pending") => ({
  id,
  email,
  role: "member",
  invitedBy: { id: ME.id, name: ME.name },
  createdAt: "",
  expiresAt: "",
  status,
});

describe("Team invitations: errors, badges and focus (KOBE-294 review)", () => {
  it("shows the server's refusal of an invite and keeps the address", async () => {
    stubApi({
      "GET /v1/team/invites": [200, { invitations: [] }],
      "POST /v1/team/invites": [
        409,
        { code: "already_member", message: "That person is already a member." },
      ],
    });
    renderTeam(<TeamInvitesPage />);
    await screen.findByText("No open invitations.");
    await userEvent.type(screen.getByLabelText(/Email address/), "c@x.io");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already a member/);
    expect((screen.getByLabelText(/Email address/) as HTMLInputElement).value).toBe("c@x.io");
  });

  it("shows a list that fails to load as an error", async () => {
    stubApi({
      "GET /v1/team/invites": [403, { code: "forbidden", message: "Not allowed." }],
    });
    renderTeam(<TeamInvitesPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Not allowed\./);
  });

  it("labels pending and expired invitations in words", async () => {
    stubApi({
      "GET /v1/team/invites": [
        200,
        { invitations: [invite("i-1", "a@x.io"), invite("i-2", "b@x.io", "expired")] },
      ],
    });
    renderTeam(<TeamInvitesPage />);
    const table = await screen.findByRole("table", { name: "Open invitations to Finance" });
    const [first, second] = within(table).getAllByRole("row").slice(1);
    expect(within(first as HTMLElement).getByText("Pending")).toBeTruthy();
    expect(within(second as HTMLElement).getByText("Expired").dataset["tone"]).toBe("attention");
  });

  it("after a revoke, focus moves to the next row's Revoke, or to the list's heading", async () => {
    stubApi({
      "GET /v1/team/invites": [
        [200, { invitations: [invite("i-1", "a@x.io"), invite("i-2", "b@x.io")] }],
        [200, { invitations: [invite("i-2", "b@x.io")] }],
        [200, { invitations: [] }],
      ],
      "DELETE /v1/team/invites/i-1": [204],
      "DELETE /v1/team/invites/i-2": [204],
    });
    renderTeam(<TeamInvitesPage />);
    const revoke = async (email: string) => {
      await userEvent.click(
        await screen.findByRole("button", { name: `Revoke invitation to ${email}` }),
      );
      const dialog = await screen.findByRole("alertdialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    };
    await revoke("a@x.io");
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Revoke invitation to b@x.io"),
    );
    await revoke("b@x.io");
    await screen.findByText("No open invitations.");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Open invitations"));
  });
});
