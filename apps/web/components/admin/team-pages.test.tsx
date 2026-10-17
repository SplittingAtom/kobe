// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { TeamAgentsPage } from "./team/agents-page";
import { TeamInvitesPage } from "./team/invites-page";
import { MembersPage } from "./team/members-page";
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
  forbidNativeConfirm();
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
        { invitation: { id: "i-1", email: "c@x.io", role: "builder" } },
      ],
    });
    renderTeam(<TeamInvitesPage />);
    await screen.findByText("No open invitations.");
    await userEvent.type(screen.getByLabelText(/Email address/), "c@x.io");
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
  schedules: [],
  orbitScore: { status: "none", attackSuccessRate: null, at: null },
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
const GALLERY_LIST = "GET /v1/agents?scope=gallery";
const NO_GALLERY: [number, unknown] = [200, { agents: [] }];
const GALLERY = {
  agents: [
    {
      id: "g-1",
      scope: "gallery",
      slug: "analyst",
      name: "Analyst",
      description: "Reads spreadsheets",
      status: "active",
      ownerUserId: null,
      currentVersion: 1,
      revision: 1,
      updatedAt: "2026-10-01T10:00:00Z",
      canEdit: false,
      starters: [],
    },
  ],
};

describe("Agent inventory", () => {
  it("shows owner, scope, status, versions, usage and placeholders, and pages", async () => {
    const calls = stubApi({
      [GALLERY_LIST]: NO_GALLERY,
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

  it("lists each agent's schedules with owner and status (KOBE-180)", async () => {
    const schedule = (over: Record<string, unknown>) => ({
      scheduleId: "s-1",
      ownerUserId: "u-bob",
      ownerName: "Bob",
      status: "active",
      pausedBy: null,
      nextDueAt: "2026-10-12T09:00:00Z",
      ...over,
    });
    stubApi({
      [GALLERY_LIST]: NO_GALLERY,
      [LIST]: [200, AGENTS],
      "GET /v1/agents/inventory": [
        200,
        {
          agents: [
            item({
              schedules: [
                schedule({}),
                schedule({
                  scheduleId: "s-2",
                  ownerName: "Carol",
                  status: "paused",
                  pausedBy: "team_admin",
                }),
                schedule({
                  scheduleId: "s-3",
                  ownerName: "Dan",
                  status: "paused",
                  pausedBy: "deactivation",
                }),
                schedule({ scheduleId: "s-4", ownerName: "Eve", status: "paused" }),
              ],
            }),
          ],
          nextCursor: null,
        },
      ],
    });
    renderTeam(<TeamAgentsPage />);
    const row = (await screen.findByRole("row", { name: /Carol/ })) as HTMLElement;
    const cells = within(row)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(cells).toEqual([
      "Bob: active",
      "Carol: paused by a team admin",
      "Dan: paused (owner deactivated or removed)",
      "Eve: paused",
    ]);
  });

  it("suspends and reactivates any listed agent, personal ones included", async () => {
    const calls = stubApi({
      [GALLERY_LIST]: NO_GALLERY,
      [LIST]: [200, AGENTS],
      "GET /v1/agents/inventory": [200, { ...INVENTORY_1, nextCursor: null }],
      "PUT /v1/agents/inventory/p-1/status": [
        200,
        { id: "p-1", scope: "personal", status: "suspended" },
      ],
    });
    renderTeam(<TeamAgentsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Suspend Mine" }));
    await answerConfirm("Suspend Mine?", "Suspend Mine");
    await screen.findByText("Mine is suspended.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ status: "suspended" });
    expect(put.headers.get("x-kobe-team")).toBe(TEAM.id);
    expect(screen.getByRole("button", { name: "Reactivate Mine" })).toBeTruthy();
  });

  it("offers Export to Orbit only for published agents the caller may export", async () => {
    const calls = stubApi({
      [GALLERY_LIST]: NO_GALLERY,
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
      [GALLERY_LIST]: NO_GALLERY,
      [LIST]: [200, AGENTS],
      "GET /v1/agents/inventory": [200, { ...INVENTORY_1, nextCursor: null }],
      "PUT /v1/agents/inventory/a-1/status": [
        403,
        { code: "forbidden", message: "Only team admins suspend agents." },
      ],
    });
    renderTeam(<TeamAgentsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Suspend Triage" }));
    await answerConfirm("Suspend Triage?", "Suspend Triage");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Only team admins suspend/);
  });
});

describe("Orbit scores in the inventory and gallery (KOBE-94)", () => {
  const scored = (id: string, name: string, orbitScore: Record<string, unknown>) =>
    item({ id, slug: id, name, orbitScore });

  it("shows each agent's latest score and status", async () => {
    stubApi({
      [GALLERY_LIST]: NO_GALLERY,
      [LIST]: [200, AGENTS],
      "GET /v1/agents/inventory": [
        200,
        {
          agents: [
            scored("a-ok", "Okay", {
              status: "passed",
              attackSuccessRate: 0.1,
              at: "2026-10-03T10:00:00Z",
            }),
            scored("a-bad", "Bad", {
              status: "blocked",
              attackSuccessRate: 0.6,
              at: "2026-10-03T10:00:00Z",
            }),
            scored("a-err", "Broken", {
              status: "errored",
              attackSuccessRate: null,
              at: "2026-10-03T10:00:00Z",
            }),
            scored("a-run", "Busy", { status: "evaluating", attackSuccessRate: null, at: null }),
            scored("a-none", "Fresh", { status: "none", attackSuccessRate: null, at: null }),
          ],
          nextCursor: null,
        },
      ],
    });
    renderTeam(<TeamAgentsPage />);
    const row = async (name: string) =>
      (await screen.findByRole("rowheader", { name })).closest("tr") as HTMLElement;
    expect((await row("Okay")).textContent).toContain("10% (passed)");
    expect((await row("Bad")).textContent).toContain("60% (blocked)");
    expect((await row("Broken")).textContent).toContain("Errored");
    expect((await row("Busy")).textContent).toContain("Evaluating…");
    expect((await row("Fresh")).textContent).not.toMatch(/passed|blocked|Errored|Evaluating/);
  });

  it("shows a gallery agent's published score and date, or that it is not evaluated", async () => {
    const second = { ...GALLERY.agents[0], id: "g-2", slug: "writer", name: "Writer" };
    stubApi({
      [GALLERY_LIST]: [200, { agents: [GALLERY.agents[0], second] }],
      [LIST]: [200, AGENTS],
      "GET /v1/agents/gallery-scores": [
        200,
        {
          scores: [
            {
              agentId: "g-1",
              version: 1,
              status: "passed",
              attackSuccessRate: 0.04,
              attempts: 25,
              threshold: 0.2,
              evaluatedAt: "2026-10-04T09:30:00Z",
            },
          ],
        },
      ],
    });
    renderTeam(<TeamAgentsPage />, { role: "member", permissions: ["team.agents.use"] });
    const analyst = (await screen.findByRole("rowheader", { name: /Analyst/ })).closest("tr");
    expect(
      await within(analyst as HTMLElement).findByText("4% attacks succeeded (passed)"),
    ).toBeTruthy();
    expect(
      within(analyst as HTMLElement)
        .getByText(/v1,/)
        .querySelector("time"),
    ).toBeTruthy();
    const writer = (await screen.findByRole("rowheader", { name: /Writer/ })).closest("tr");
    expect(within(writer as HTMLElement).getByText("Not evaluated")).toBeTruthy();
  });
});

describe("Team agents", () => {
  it("lists the team's agents with their builder links", async () => {
    stubApi({
      [GALLERY_LIST]: NO_GALLERY,
      [LIST]: [200, AGENTS],
      "GET /v1/agents/inventory": [200, { agents: [], nextCursor: null }],
    });
    renderTeam(<TeamAgentsPage />);
    expect(await screen.findByText("v2")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit Triage" })).toBeTruthy();
  });

  it("lets a builder open agents but offers no suspend button", async () => {
    stubApi({
      [GALLERY_LIST]: NO_GALLERY,
      "GET /v1/agents?scope=team&include_archived=true": [200, AGENTS],
    });
    renderTeam(<TeamAgentsPage />, { role: "builder", permissions: ["team.agents.build"] });
    expect(await screen.findByText("v2")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit Triage" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Suspend/ })).toBeNull();
  });

  it("explains 503 isolation_runtime_missing and links to the fix", async () => {
    stubApi({
      [GALLERY_LIST]: NO_GALLERY,
      "GET /v1/agents/inventory": [200, { agents: [], nextCursor: null }],
      "GET /v1/agents?scope=team&include_archived=true": [
        503,
        {
          code: "isolation_runtime_missing",
          message:
            "Isolation runtime missing: agents are disabled until a site admin fixes the cluster's gVisor or Kata runtime.",
        },
      ],
    });
    renderTeam(<TeamAgentsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Isolation runtime missing/);
    expect(screen.getByRole("link", { name: "Isolation" }).getAttribute("href")).toBe(
      "/admin/site/isolation",
    );
  });

  it("hides internals of other 5xx answers", async () => {
    stubApi({
      [GALLERY_LIST]: NO_GALLERY,
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

describe("Gallery agents on the team page (KOBE-87)", () => {
  it("lists the gallery and forks into the team for builders", async () => {
    const forked = { ...GALLERY.agents[0], id: "f-1", scope: "team", canEdit: true };
    const calls = stubApi({
      [GALLERY_LIST]: [200, GALLERY],
      [LIST]: [200, AGENTS],
      "POST /v1/agents/g-1/fork": [201, { agent: forked }],
    });
    renderTeam(<TeamAgentsPage />, { role: "builder", permissions: ["team.agents.build"] });
    await userEvent.click(await screen.findByRole("button", { name: "Fork to team Analyst" }));
    await screen.findByText("Forked Analyst into your team's agents.");
    expect(screen.getByRole("link", { name: "Open Analyst" }).getAttribute("href")).toBe(
      "/admin/team/agents/f-1",
    );
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({ scope: "team" });
    expect(post.headers.get("x-kobe-team")).toBe(TEAM.id);
    // The team list is reloaded to show the new agent.
    expect(
      calls.filter((c) => c.url === "/v1/agents?scope=team&include_archived=true"),
    ).toHaveLength(2);
  });

  it("shows the gallery without Fork to members", async () => {
    stubApi({ [GALLERY_LIST]: [200, GALLERY], [LIST]: [200, AGENTS] });
    renderTeam(<TeamAgentsPage />, { role: "member", permissions: ["team.agents.use"] });
    expect(await screen.findByText("Reads spreadsheets")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Fork to team/ })).toBeNull();
  });

  it("explains a refused fork", async () => {
    stubApi({
      [GALLERY_LIST]: [200, GALLERY],
      [LIST]: [200, AGENTS],
      "POST /v1/agents/g-1/fork": [
        403,
        { code: "forbidden", message: "You can't copy this agent there." },
      ],
    });
    renderTeam(<TeamAgentsPage />, { role: "builder", permissions: ["team.agents.build"] });
    await userEvent.click(await screen.findByRole("button", { name: "Fork to team Analyst" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't copy/);
  });
});
