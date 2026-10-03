// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSection } from "../../lib/admin/nav/registry";
import { must } from "../../lib/testing/must";
import { ConsoleLinks } from "./console-links";
import { ConsoleOverview } from "./overview";
import { SectionPlaceholder } from "./placeholder";
import { ME, renderInstall, renderTeam, stubApi } from "./testing";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("console overview", () => {
  it("lists the install sections with what each is for, placeholders marked", () => {
    renderInstall(<ConsoleOverview kind="install" />);
    expect(screen.getByRole("heading", { level: 1, name: "Install console" })).toBeTruthy();
    const people = screen.getByRole("region", { name: "People" });
    expect(within(people).getByRole("link", { name: "Users" }).getAttribute("href")).toBe(
      "/admin/install/users",
    );
    const models = screen.getByRole("region", { name: "Models and connectors" });
    expect(models.textContent).toMatch(/Coming in KOBE-44/);
  });

  it("lists only the team sections the role covers", () => {
    renderTeam(<ConsoleOverview kind="team" />);
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Members and roles",
      "Invitations",
      "Team agents",
      "Inventory",
      "Audit view",
      "Break-glass access",
    ]);
  });
});

describe("section placeholder", () => {
  it("names the ticket that builds it", () => {
    render(<SectionPlaceholder section={must(findSection("install", "legal-hold"))} />);
    expect(screen.getByRole("heading", { name: "Legal hold" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toBe("Coming in KOBE-17.");
  });
});

describe("console links on the home page", () => {
  const me = (installRole: string | null) =>
    [200, { user: { ...ME, twoFactorEnabled: false }, installRole }] as const;
  const team = (role: string, permissions: string[]) =>
    [200, { team: { id: "t-1", slug: "fin", name: "Finance" }, role, permissions }] as const;

  it("shows both consoles to an Owner who is a team admin", async () => {
    stubApi({
      "GET /v1/me": me("owner"),
      "GET /v1/team": team("team_admin", ["team.members.manage"]),
    });
    render(<ConsoleLinks />);
    const nav = await screen.findByRole("navigation", { name: "Administration" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/admin/install", "/admin/team"]);
  });

  it("shows nothing to a member", async () => {
    const calls = stubApi({
      "GET /v1/me": me(null),
      "GET /v1/team": team("member", ["team.read", "team.members.read"]),
    });
    render(<ConsoleLinks />);
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.queryByRole("navigation", { name: "Administration" })).toBeNull();
  });

  it("shows the install console to an Admin with no active team", async () => {
    stubApi({ "GET /v1/me": me("admin"), "GET /v1/team": [409, { code: "no_active_team" }] });
    render(<ConsoleLinks />);
    const nav = await screen.findByRole("navigation", { name: "Administration" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Install console"]);
  });
});
