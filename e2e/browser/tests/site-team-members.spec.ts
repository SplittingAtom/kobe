import { expect, test, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { pageApi, secondBrowser } from "./support/gate5.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-638: a site admin (KOBE_USER, the gate1 Owner) manages a team's members in Site console ›
 * Teams without an invitation. Manage members of a team member2 (KOBE_USER2 / KOBE_PW2) is not in
 * (KOBE_SITE_MEMBERS_TEAM = its slug, else the first such team): search member2, add as Member
 * (the row says "Added by a site admin" and member2 sees "… added you to this team" in that
 * team's notifications), change the role to Contributor, remove after confirming. The finally
 * block removes member2 from the team again if a step failed, so the site ends as it began. Spends
 * no model tokens. Run on gate1: `npx playwright test site-team-members`.
 */
const USER2 = process.env["KOBE_USER2"];
const PW2 = process.env["KOBE_PW2"];
const WANTED = process.env["KOBE_SITE_MEMBERS_TEAM"];

interface Team {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

async function pickTeam(page: Page, userId: string): Promise<Team | null> {
  const teams = await pageApi<{ teams: Team[] }>(page, "GET", "/v1/site/teams");
  for (const t of teams.json.teams ?? []) {
    if (WANTED && t.slug !== WANTED) continue;
    const roster = await pageApi<{ members: { userId: string }[] }>(
      page,
      "GET",
      `/v1/site/teams/${t.id}/members`,
    );
    if (!roster.json.members.some((m) => m.userId === userId)) return t;
  }
  return null;
}

async function memberNotices(page: Page, teamId: string): Promise<string[]> {
  return page.evaluate(async (teamId) => {
    await fetch("/v1/me/teams/active", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId }),
    });
    const res = await fetch("/v1/notifications", { headers: { "x-kobe-team": teamId } });
    const body = (await res.json()) as { notifications?: { kind: string }[] };
    return (body.notifications ?? []).map((n) => n.kind);
  }, teamId);
}

test("a site admin adds member2 to a team without an invitation, changes the role, removes them", async ({
  page,
  browser,
}) => {
  test.skip(!USER2 || !PW2, "KOBE_USER2 and KOBE_PW2 are required");
  const panel = panelOf(page);
  await page.goto("/admin/site/teams");
  await expect(panel.getByRole("heading", { level: 1, name: "Teams" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const users = await pageApi<{ users: { id: string; name: string; email: string }[] }>(
    page,
    "GET",
    "/v1/site/users",
  );
  const member2 = users.json.users.find((u) => u.email === USER2?.toLowerCase());
  expect(member2, "member2 is a Kobe user").toBeTruthy();
  if (!member2) return;
  const team = await pickTeam(page, member2.id);
  test.skip(!team, "No team without member2 (set KOBE_SITE_MEMBERS_TEAM).");
  if (!team) return;

  try {
    await panel.getByRole("button", { name: `Manage members of ${team.name}` }).click();
    const roster = panel.getByRole("table", { name: `Members of ${team.name}` });
    await expect(roster).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    // Add: search, tick, choose the role, Add. No invitation.
    const search = panel.getByRole("form", { name: `Search users for ${team.name}` });
    await search.getByLabel("Name or email").fill(member2.email);
    await search.getByRole("button", { name: "Search" }).click();
    const adder = panel.getByRole("region", { name: `Add members to ${team.name}` });
    await adder.getByLabel(`${member2.name} (${member2.email})`).check();
    await adder.getByLabel("Team role").selectOption("member");
    await adder.getByRole("button", { name: "Add 1 user" }).click();
    await expect(panel.getByText(`Added ${member2.name} to ${team.name} as Member.`)).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    const row = roster.getByRole("row").filter({ hasText: member2.email });
    await expect(row).toContainText("Added by a site admin");
    await expect(row).toContainText("Active");

    // member2 is in at once and was told.
    const second = await secondBrowser(browser, USER2, PW2);
    try {
      expect(await memberNotices(second, team.id)).toContain("team.member.added");
    } finally {
      await second.context().close();
    }

    // Change the role.
    await row.getByLabel(`Role of ${member2.name}`, { exact: true }).selectOption("contributor");
    await row.getByRole("button", { name: `Save role of ${member2.name}` }).click();
    await expect(
      panel.getByText(`${member2.name} is now Contributor in ${team.name}.`),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    // Remove.
    await row.getByRole("button", { name: `Remove ${member2.name}` }).click();
    const dialog = page.getByRole("alertdialog", {
      name: `Remove ${member2.name} from ${team.name}?`,
    });
    await dialog.getByRole("button", { name: `Remove ${member2.name}` }).click();
    await expect(panel.getByText(`${member2.name} was removed from ${team.name}.`)).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(roster.getByRole("row").filter({ hasText: member2.email })).toHaveCount(0);
  } finally {
    // Restore: member2 is not in the team (a no-op 404 when the spec removed them).
    await pageApi(page, "DELETE", `/v1/site/teams/${team.id}/members/${member2.id}`);
  }
});
