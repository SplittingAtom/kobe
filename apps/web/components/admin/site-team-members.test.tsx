// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { TeamMembersPanel } from "./site/team-members-panel";
import { ME, answerConfirm, forbidNativeConfirm, renderSite, stubApi, summary } from "./testing";

/** KOBE-638: a Site admin manages one team's members from Site console › Teams. */
const TEAM = { id: "t-1", slug: "fin", name: "Finance" };
const BASE = "/v1/site/teams/t-1";
const member = (userId: string, name: string, role: string, extra: object = {}) => ({
  userId,
  name,
  email: `${userId}@x.io`,
  role,
  joinedAt: "2026-10-01T10:00:00Z",
  addedVia: null,
  managedBy: null,
  deactivated: false,
  ...extra,
});
const ROSTER = {
  members: [
    member("u-ann", "Ann", "team_admin"),
    member("u-bob", "Bob", "member", { addedVia: "site_admin" }),
    member("u-cy", "Cy", "contributor", {
      addedVia: "idp",
      managedBy: { providerId: "p-1", providerName: "Contoso" },
    }),
    member("u-dee", "Dee", "member", { deactivated: true }),
    member(ME.id, ME.name, "member", { addedVia: "site_admin" }),
  ],
};

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Site console team members (KOBE-638)", () => {
  it("lists name, email, role, how they joined and status; never offers your own row", async () => {
    stubApi({ [`GET ${BASE}/members`]: [200, ROSTER] });
    renderSite(<TeamMembersPanel team={TEAM} />);
    const table = await screen.findByRole("table", { name: "Members of Finance" });
    const row = (name: string) =>
      must(
        within(table)
          .getByRole("rowheader", { name: new RegExp(name) })
          .closest("tr"),
      );
    expect(row("Ann").textContent).toMatch(/Invitation.*Active/);
    expect(row("Bob").textContent).toMatch(/Added by a site admin/);
    expect(row("Cy").textContent).toMatch(/Managed by Contoso/);
    expect(row("Dee").textContent).toMatch(/Deactivated/);
    // A managed row: no role select or Remove, only Take over.
    expect(within(row("Cy")).queryByLabelText("Role of Cy")).toBeNull();
    expect(within(row("Cy")).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(within(row("Cy")).getByRole("button", { name: /Take over/ })).toBeTruthy();
    // Your own row is read-only.
    expect(within(row(ME.name)).queryByRole("button")).toBeNull();
    expect(within(row(ME.name)).queryByRole("combobox")).toBeNull();
  });

  it("searches, picks several users and adds them with one role, no invitation", async () => {
    const calls = stubApi({
      [`GET ${BASE}/members`]: [200, ROSTER],
      [`GET ${BASE}/candidates?q=e`]: [
        200,
        {
          candidates: [
            { userId: "u-eve", name: "Eve", email: "eve@x.io" },
            { userId: "u-fe", name: "Fe", email: "fe@x.io" },
          ],
        },
      ],
      [`POST ${BASE}/members`]: [201, { added: [] }],
    });
    renderSite(<TeamMembersPanel team={TEAM} />);
    await screen.findByRole("table");
    const form = screen.getByRole("form", { name: "Search users for Finance" });
    await userEvent.type(within(form).getByLabelText("Name or email"), "e");
    await userEvent.click(within(form).getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByLabelText("Eve (eve@x.io)"));
    await userEvent.click(screen.getByLabelText("Fe (fe@x.io)"));
    await userEvent.selectOptions(screen.getByLabelText("Team role"), "contributor");
    await userEvent.click(screen.getByRole("button", { name: "Add 2 users" }));
    await screen.findByText("Added Eve, Fe to Finance as Contributor.");
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({
      userIds: ["u-eve", "u-fe"],
      role: "contributor",
    });
    // The roster reloads after the Add.
    expect(summary(calls).filter((c) => c === `GET ${BASE}/members`)).toHaveLength(2);
  });

  it("shows the server's refusal of an Add (deactivated user)", async () => {
    stubApi({
      [`GET ${BASE}/members`]: [200, ROSTER],
      [`GET ${BASE}/candidates`]: [
        200,
        { candidates: [{ userId: "u-eve", name: "Eve", email: "eve@x.io" }] },
      ],
      [`POST ${BASE}/members`]: [
        409,
        { code: "user_deactivated", message: "That account is deactivated. Reactivate it first." },
      ],
    });
    renderSite(<TeamMembersPanel team={TEAM} />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByLabelText("Eve (eve@x.io)"));
    await userEvent.click(screen.getByRole("button", { name: "Add 1 user" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/deactivated/);
  });

  it("changes a role, removes after confirming, and takes over a managed row", async () => {
    const calls = stubApi({
      [`GET ${BASE}/members`]: [200, ROSTER],
      [`PATCH ${BASE}/members/u-bob`]: [200, { userId: "u-bob", role: "contributor" }],
      [`DELETE ${BASE}/members/u-bob?expectedRole=member`]: [204],
      [`POST ${BASE}/members/u-cy/take-over`]: [200, { userId: "u-cy", managedBy: null }],
    });
    renderSite(<TeamMembersPanel team={TEAM} />);
    await screen.findByRole("table");
    await userEvent.selectOptions(screen.getByLabelText("Role of Bob"), "contributor");
    await userEvent.click(screen.getByRole("button", { name: "Save role of Bob" }));
    await screen.findByText("Bob is now Contributor in Finance.");
    // The role the roster showed is the condition (review L2).
    expect(JSON.parse(String(must(calls.find((c) => c.method === "PATCH")).body))).toEqual({
      role: "contributor",
      expectedRole: "member",
    });

    await userEvent.click(screen.getByRole("button", { name: "Remove Bob" }));
    expect(await answerConfirm("Remove Bob from Finance?", "Remove Bob")).toMatch(/audit log/);
    await screen.findByText("Bob was removed from Finance.");

    await userEvent.click(screen.getByRole("button", { name: "Take over membership of Cy" }));
    await answerConfirm("Take over Cy's membership?", "Take over");
    await screen.findByText("Cy's membership is no longer managed by Contoso.");
    expect(summary(calls)).toEqual(
      expect.arrayContaining([
        `DELETE ${BASE}/members/u-bob?expectedRole=member`,
        `POST ${BASE}/members/u-cy/take-over`,
      ]),
    );
  });

  it("shows last_team_admin when a demotion is refused", async () => {
    stubApi({
      [`GET ${BASE}/members`]: [200, ROSTER],
      [`PATCH ${BASE}/members/u-ann`]: [
        409,
        {
          code: "last_team_admin",
          message: "A team needs at least one team admin. Promote someone else first.",
        },
      ],
    });
    renderSite(<TeamMembersPanel team={TEAM} />);
    await screen.findByRole("table");
    await userEvent.selectOptions(screen.getByLabelText("Role of Ann"), "member");
    await userEvent.click(screen.getByRole("button", { name: "Save role of Ann" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/at least one team admin/);
  });

  it("says so when the member changed since the roster loaded, and reloads (review L2)", async () => {
    const calls = stubApi({
      [`GET ${BASE}/members`]: [200, ROSTER],
      [`DELETE ${BASE}/members/u-bob?expectedRole=member`]: [
        409,
        {
          code: "changed_since_approval",
          message:
            "The member's role changed since you loaded it; nothing was changed. Check the current role and try again.",
        },
      ],
    });
    renderSite(<TeamMembersPanel team={TEAM} />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Remove Bob" }));
    await answerConfirm("Remove Bob from Finance?", "Remove Bob");
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed since you loaded it/);
    expect(summary(calls).filter((c) => c === `GET ${BASE}/members`)).toHaveLength(2);
  });
});
