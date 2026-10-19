// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTeam, stubApi } from "../admin/testing";
import { TeamUsageSection } from "../admin/team/skill-editor/team-usage-section";
import { CatalogTab } from "./catalog-tab";
import { SkillUsagePanel } from "./skill-usage-panel";

/** KOBE-339 (SK26): usage signals for members, Team admins, maintainers and Site admins. */
const WINDOW = { from: "2026-09-19T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = (name: string, over: Record<string, unknown>) => ({
  id: `id-${name}`,
  name,
  summary: "S.",
  publisher: "maintainer",
  status: "active",
  topics: [],
  latest: { version_id: "v", semver: "1.0.0", verdict: "pass", approved_at: null },
  score: null,
  teams_installed: "few",
  usage: { members: "few", thumbs_up: "few" },
  state: { installed: null, added_by_me: false, blocked: false },
  ...over,
});

describe("catalog cards", () => {
  it("show teams, members and the thumbs-up share, or Few", async () => {
    stubApi({
      "GET /v1/skills/catalog": [
        200,
        {
          skills: [
            card("big", { teams_installed: 12, usage: { members: 40, thumbs_up: 0.95 } }),
            card("small", {}),
          ],
          tags: [],
          members_may_add: true,
          usage_window: WINDOW,
        },
      ],
    });
    renderTeam(<CatalogTab />, { role: "member", permissions: ["team.read"] });
    const big = (await screen.findByRole("link", { name: "big" })).closest("li") as HTMLElement;
    expect(within(big).getByText("12 teams")).toBeTruthy();
    expect(within(big).getByText("40 members in 30 days")).toBeTruthy();
    expect(within(big).getByText("95% thumbs up")).toBeTruthy();
    const small = screen.getByRole("link", { name: "small" }).closest("li") as HTMLElement;
    expect(within(small).getByText("Few teams")).toBeTruthy();
    expect(within(small).getByText("Few members in 30 days")).toBeTruthy();
    expect(within(small).getByText("Few ratings")).toBeTruthy();
    // No sorting by thumbs.
    const sort = screen.getByLabelText("Sort by");
    expect(within(sort).queryByText(/thumbs/i)).toBeNull();
  });
});

const SITE = {
  totals: { teams_installed: 4, members: 5, runs: 23, thumbs_up: 0.95, opt_outs: "few" },
  versions: ["2.0.0", "1.0.0", "other"],
  per_version: { teams_running: null, members: ["few", 5, "few"], runs: null, thumbs_up: null },
  window: WINDOW,
  refreshed_at: "2026-10-19T00:05:00.000Z",
};

describe("maintainers' and Site admins' usage panel", () => {
  it("shows totals and per version, withheld columns said so", async () => {
    stubApi({ "GET /v1/skills/catalog/s1/usage": [200, SITE] });
    render(<SkillUsagePanel skillId="s1" />);
    const totals = await screen.findByRole("table", { name: "Site-wide usage" });
    expect(within(totals).getByText("23")).toBeTruthy();
    expect(within(totals).getByText("95%")).toBeTruthy();
    const per = screen.getByRole("table", { name: "Usage by version" });
    expect(within(per).getAllByText("Withheld").length).toBeGreaterThan(0);
    expect(within(per).getByText("5")).toBeTruthy();
    expect(screen.getByText(/2026-09-19 to 2026-10-18/)).toBeTruthy();
    expect(within(per).getByText("Other or unknown")).toBeTruthy();
  });

  it("shows nothing to others (403)", async () => {
    stubApi({ "GET /v1/skills/catalog/s1/usage": [403, { code: "forbidden", message: "x" }] });
    const { container } = render(<SkillUsagePanel skillId="s1" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });
});

describe("Team admins' usage section", () => {
  it("lists the team's runs, members and thumbs per skill", async () => {
    stubApi({
      "GET /v1/team/skills/usage": [
        200,
        {
          skills: [
            {
              skill_id: "s1",
              name: "usage-report",
              runs: 7,
              members: 2,
              thumbs: { enough: true, up: 6, down: 1 },
              versions: [{ semver: "1.0.0", runs: 7, members: 2 }],
              version_thumbs: null,
            },
            {
              skill_id: "s2",
              name: "other",
              runs: "few",
              members: "few",
              thumbs: { enough: false },
              versions: null,
              version_thumbs: null,
            },
          ],
          window: WINDOW,
          refreshed_at: "2026-10-19T00:05:00.000Z",
        },
      ],
    });
    renderTeam(<TeamUsageSection />, {
      role: "team_admin",
      permissions: ["team.read", "team.skills.installs.manage"],
    });
    const table = await screen.findByRole("table", { name: "Catalog skill usage" });
    expect(within(table).getByText("usage-report")).toBeTruthy();
    expect(within(table).getByText("6 up, 1 down")).toBeTruthy();
    expect(within(table).getByText("Not enough ratings yet")).toBeTruthy();
    // Under three members other than the viewer: Few, and no version table.
    expect(within(table).getAllByText("Few")).toHaveLength(2);
    expect(within(table).getByText("Withheld: too few members")).toBeTruthy();
    expect(within(table).getByText(/1\.0\.0: 7 runs, 2 members/)).toBeTruthy();
  });
});
