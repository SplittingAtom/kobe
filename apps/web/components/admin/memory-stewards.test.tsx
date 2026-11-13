// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SITE_STEWARD_HINT, SiteMemoryStewardsSection } from "./site/memory-stewards-section";
import { SkillReviewersSection } from "./site/skill-reviewers-section";
import { WORKSPACE_STEWARD_HINT } from "./team/memory-stewards-section";
import { MembersPage } from "./team/members-page";
import {
  ME,
  TEAM,
  answerConfirm,
  forbidNativeConfirm,
  renderSite,
  renderTeam,
  stubApi,
} from "./testing";

/** KOBE-380 (SM19): memory stewards on the Workspace Members page and in Site roles. */
const member = (userId: string, name: string, role: string, deactivated = false) => ({
  userId,
  name,
  email: `${userId}@x.io`,
  role,
  joinedAt: "2026-10-01T10:00:00Z",
  ...(deactivated ? { deactivated: true } : {}),
});
const MEMBERS = {
  members: [
    member(ME.id, ME.name, "team_admin"),
    member("u-bob", "Bob", "contributor"),
    member("u-cy", "Cy", "member"),
    member("u-dee", "Dee", "member", true),
  ],
};
const steward = (userId: string, name: string) => ({
  user_id: userId,
  name,
  granted_by: ME.id,
  granted_at: "2026-11-12T09:00:00Z",
});

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Workspace memory stewards on the Members page", () => {
  it("explains stewardship and makes a member of any role a steward", async () => {
    const calls = stubApi({
      "GET /v1/team/members": [200, MEMBERS],
      "GET /v1/team/memory/stewards": [
        [200, { level: "team", stewards: [steward("u-cy", "Cy")] }],
        [200, { level: "team", stewards: [steward("u-bob", "Bob"), steward("u-cy", "Cy")] }],
      ],
      "PUT /v1/team/memory/stewards/u-bob": [200, steward("u-bob", "Bob")],
    });
    renderTeam(<MembersPage />);
    expect(await screen.findByText(WORKSPACE_STEWARD_HINT)).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Memory stewards" });
    expect(within(table).getByText("Cy")).toBeTruthy();
    expect(within(table).getByText("Member")).toBeTruthy();
    const form = screen.getByRole("form", { name: "Make a memory steward" });
    // Active members who are not stewards yet; a Contributor is offered like anyone.
    expect(
      within(form)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a member…", `${ME.name} (Team admin)`, "Bob (Contributor)"]);
    await userEvent.selectOptions(within(form).getByLabelText("Member"), "u-bob");
    await userEvent.click(within(form).getByRole("button", { name: "Make memory steward" }));
    await screen.findByText("Bob is now a memory steward.");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/v1/team/memory/stewards/u-bob");
    expect(put?.headers.get("x-kobe-team")).toBe(TEAM.id);
  });

  it("asks before taking the grant", async () => {
    const calls = stubApi({
      "GET /v1/team/members": [200, MEMBERS],
      "GET /v1/team/memory/stewards": [
        [200, { level: "team", stewards: [steward("u-cy", "Cy")] }],
        [200, { level: "team", stewards: [] }],
      ],
      "DELETE /v1/team/memory/stewards/u-cy": [204],
    });
    renderTeam(<MembersPage />);
    const take = await screen.findByRole("button", { name: "Take memory steward from Cy" });
    await userEvent.click(take);
    await answerConfirm("Take memory steward from Cy?", "Cancel");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Take memory steward from Cy" }));
    await answerConfirm("Take memory steward from Cy?", "Take memory steward");
    await screen.findByText("Cy is no longer a memory steward.");
    expect(await screen.findByText("No memory stewards yet.")).toBeTruthy();
  });
});

describe("Site memory stewards in Site roles", () => {
  const user = (id: string, name: string, siteRole = "user") => ({
    id,
    name,
    email: `${id}@x.io`,
    siteRole,
    deactivatedAt: null,
    createdAt: "2026-10-01T10:00:00Z",
  });
  const USERS = {
    users: [user("u-ann", "Ann", "admin"), user("u-bob", "Bob"), user("u-cy", "Cy")],
  };
  const grant = (userId: string, name: string, kind: string) => ({
    userId,
    name,
    email: `${userId}@x.io`,
    grant: kind,
    grantedBy: "u-ann",
    grantedAt: "2026-11-12T10:00:00Z",
  });
  const GRANTS = {
    grants: [grant("u-bob", "Bob", "skill_reviewer"), grant("u-cy", "Cy", "memory_steward")],
  };

  it("lists only stewards, offers plain users, and gives the grant", async () => {
    const calls = stubApi({
      "GET /v1/site/roles/grants": [200, GRANTS],
      "GET /v1/site/users": [200, USERS],
      "PUT /v1/site/roles/grants/u-bob/memory_steward": [200, { changed: true }],
    });
    renderSite(<SiteMemoryStewardsSection />, "admin");
    expect(screen.getByText(SITE_STEWARD_HINT)).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Site memory stewards" });
    expect(within(table).queryByText("Bob")).toBeNull();
    expect(within(table).getByText("Cy")).toBeTruthy();
    const form = screen.getByRole("form", { name: "Give Site memory steward" });
    // Site admins already curate Site memory: not offered.
    expect(
      within(form)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a user…", "Bob (u-bob@x.io)"]);
    await userEvent.selectOptions(within(form).getByLabelText("Steward"), "u-bob");
    await userEvent.click(within(form).getByRole("button", { name: "Make Site memory steward" }));
    await screen.findByText("Bob is now a Site memory steward.");
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual([
      "/v1/site/roles/grants/u-bob/memory_steward",
    ]);
  });

  it("asks before taking it", async () => {
    const calls = stubApi({
      "GET /v1/site/roles/grants": [200, GRANTS],
      "GET /v1/site/users": [200, USERS],
      "DELETE /v1/site/roles/grants/u-cy/memory_steward": [204],
    });
    renderSite(<SiteMemoryStewardsSection />, "admin");
    await userEvent.click(
      await screen.findByRole("button", { name: "Take Site memory steward from Cy" }),
    );
    await answerConfirm("Take Site memory steward from Cy?", "Take Site memory steward");
    await screen.findByText("Cy is no longer a Site memory steward.");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("keeps stewards out of the Skill reviewers list", async () => {
    stubApi({
      "GET /v1/site/roles/grants": [200, GRANTS],
      "GET /v1/site/users": [200, USERS],
    });
    renderSite(<SkillReviewersSection />, "admin");
    const table = await screen.findByRole("table", { name: "Skill reviewers" });
    expect(within(table).getByText("Bob")).toBeTruthy();
    expect(within(table).queryByText("Cy")).toBeNull();
  });
});
