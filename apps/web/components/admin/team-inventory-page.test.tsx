// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canSee, findSection } from "../../lib/admin/nav/registry";
import type { TeamAccess } from "../../lib/admin/nav/types";
import { must } from "../../lib/testing/must";
import { compactDateTime } from "./parts";
import { TeamInventoryPage } from "./team/inventory-page";
import { forbidNativeConfirm, ME, TEAM, renderTeam, stubApi, summary } from "./testing";

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SKILLS = "GET /v1/skills?scope=team";
const CONNECTORS = "GET /v1/team/connectors";

/** The inventory page's two lists; `routes` replaces either. */
function stubInventory(routes: Parameters<typeof stubApi>[0]) {
  return stubApi({
    [SKILLS]: [200, { skills: [] }],
    [CONNECTORS]: [200, { connectors: [] }],
    ...routes,
  });
}

describe("compactDateTime (KOBE-306)", () => {
  it("leaves out the year in the current year and shows it otherwise", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const thisYear = compactDateTime(new Date("2026-03-04T12:34:56Z"), now);
    const lastYear = compactDateTime(new Date("2025-03-04T12:34:56Z"), now);
    expect(thisYear).not.toContain("2026");
    expect(thisYear).not.toContain(":56");
    expect(lastYear).toContain("2025");
  });
});

describe("Inventory: skills and connectors (KOBE-291)", () => {
  const skill = {
    id: "s-1",
    scope: "team",
    slug: "pdf-tools",
    description: "Reads PDFs",
    latestVersion: 3,
    latestSemver: "1.2.0",
    ownerUserId: null,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
  };
  const tool = (piName: string, status = "pinned") => ({
    piName,
    name: piName,
    title: null,
    readOnly: true,
    openWorld: false,
    status,
  });
  const connector = (over: Record<string, unknown>) => ({
    id: "c-1",
    name: "Jira",
    authKind: "oauth",
    status: "active",
    iconUrl: null,
    enabled: true,
    exposure: "read_only",
    enabledTools: [],
    tools: [tool("a"), tool("b")],
    ...over,
  });

  it("lists the team's skills and its enabled connectors, for this team", async () => {
    const calls = stubInventory({
      [SKILLS]: [200, { skills: [skill] }],
      [CONNECTORS]: [
        200,
        {
          connectors: [
            connector({}),
            connector({
              id: "c-2",
              name: "GitHub",
              status: "disabled",
              exposure: "custom",
              enabledTools: ["a"],
              tools: [tool("a"), tool("b", "drifted"), tool("c")],
            }),
            connector({ id: "c-3", name: "Off", enabled: false, exposure: null }),
          ],
        },
      ],
    });
    renderTeam(<TeamInventoryPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Inventory" })).toBeTruthy();
    const skills = screen.getByRole("region", { name: "Skills" });
    const skillRow = (await within(skills).findByRole("rowheader", { name: /pdf-tools/ })).closest(
      "tr",
    ) as HTMLElement;
    expect(skillRow.textContent).toMatch(/Reads PDFs.*v1\.2\.0/);
    expect(
      within(skillRow).getByRole("link", { name: "Open pdf-tools" }).getAttribute("href"),
    ).toBe("/admin/team/skills/s-1");

    const connectors = screen.getByRole("region", { name: "Connectors" });
    const rows = within(connectors).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(must(rows[1]).textContent).toMatch(/Jira.*Active.*Read-only tools.*2 tools/);
    expect(must(rows[2]).textContent).toMatch(
      /GitHub.*Disabled by a site admin.*Chosen tools.*1 tool chosen of 3.*1 awaiting re-approval/,
    );
    expect(connectors.textContent).not.toContain("Off");

    expect(calls.every((c) => c.headers.get("x-kobe-team") === TEAM.id)).toBe(true);
    expect(summary(calls).sort()).toEqual([SKILLS, CONNECTORS].sort());
  });

  it("says when the team has no skills or connectors, and shows a failed list as an error", async () => {
    stubInventory({
      [CONNECTORS]: [200, { connectors: [connector({ enabled: false, exposure: null })] }],
    });
    renderTeam(<TeamInventoryPage />);
    expect(await screen.findByText("The team has no skills yet.")).toBeTruthy();
    expect(await screen.findByText("No connectors are enabled for the team.")).toBeTruthy();
    cleanup();

    stubInventory({
      [SKILLS]: [403, { code: "forbidden", message: "You can't see the team's skills." }],
    });
    renderTeam(<TeamInventoryPage />);
    const skills = screen.getByRole("region", { name: "Skills" });
    expect((await within(skills).findByRole("alert")).textContent).toMatch(/can't see/);
    expect(await screen.findByText("No connectors are enabled for the team.")).toBeTruthy();
  });

  it("links to the pages that change each list", async () => {
    stubInventory({});
    renderTeam(<TeamInventoryPage />);
    await screen.findByText("The team has no skills yet.");
    const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href("Skills")).toBe("/admin/team/skills");
    expect(href("Skill review")).toBe("/admin/team/skill-review");
    expect(href("Connectors")).toBe("/admin/team/connectors");
    await waitFor(() => expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull());
  });
});

describe("who may open the Inventory (KOBE-291 review)", () => {
  const access = (role: TeamAccess["role"], permissions: string[]): TeamAccess => ({
    console: "team",
    user: ME,
    team: TEAM,
    role,
    permissions,
  });
  const inventory = () => must(findSection("team", "inventory"));

  it("is a ready section for holders of team.agents.suspend (team admins) only", () => {
    expect(inventory().status.kind).toBe("ready");
    expect(canSee(inventory(), access("team_admin", ["team.agents.suspend"]))).toBe(true);
    expect(
      canSee(inventory(), access("contributor", ["team.agents.build", "team.agents.publish"])),
    ).toBe(false);
    expect(canSee(inventory(), access("member", ["team.read", "team.agents.use"]))).toBe(false);
    expect(canSee(inventory(), access("team_admin", ["team.members.manage"]))).toBe(false);
    expect(canSee(inventory(), { console: "site", user: ME, siteRole: "owner" })).toBe(false);
  });

  it("points to the Agents page's Team tab for the agents, without reading the old inventory", async () => {
    // KOBE-570: the agents and their usage moved to /agents?tab=team; skills and connectors stay.
    const calls = stubInventory({});
    renderTeam(<TeamInventoryPage />);
    const agents = screen.getByRole("region", { name: "Agents" });
    expect(agents.textContent).toMatch(/moved to the Agents page/);
    expect(
      within(agents).getByRole("link", { name: "Agents page, Team tab" }).getAttribute("href"),
    ).toBe("/agents?tab=team");
    await screen.findByText("The team has no skills yet.");
    expect(summary(calls).some((c) => c.includes("/v1/agents/inventory"))).toBe(false);
  });
});
