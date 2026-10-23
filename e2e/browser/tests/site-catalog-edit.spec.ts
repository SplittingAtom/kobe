import { expect, test, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-495: a site admin (KOBE_USER, the gate1 Owner) edits a catalog skill in the Site Console.
 * Skill tags → Catalog skills → Open shows the versions and the files; Edit from the newest version
 * opens the site draft in the Workbench editor; the spec adds a marker line to SKILL.md (autosaved),
 * reloads (the draft persisted), publishes it with the suggested version, and checks that the
 * active team's catalog now lists the new version as the newest (Default sync and Track installs
 * take it from there). A team-published skill is used (KOBE_CATALOG_SKILL, else the first one the
 * catalog lists): a Kobe skill would stay detached. Versions are immutable, so the restore at the
 * end withdraws the version the spec published (Site admins only; installs fall back to the one
 * before) and discards any draft left. Spends no model tokens. Run on gate1:
 * `npx playwright test site-catalog-edit`.
 */
const TAGS = "/admin/site/skill-tags";
const API = "/v1/site/skills";
const TEAM_KEY = "kobe.lastTeamId";

interface CatalogRow {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly latest: string | null;
}

async function pickSkill(page: Page): Promise<CatalogRow | null> {
  const wanted = process.env["KOBE_CATALOG_SKILL"];
  const skills = await page.evaluate(async (api) => {
    const res = await fetch(`${api}/catalog`);
    return ((await res.json()) as { skills: CatalogRow[] }).skills;
  }, API);
  return (
    skills.find((s) => (wanted ? s.name === wanted : s.publisher !== "kobe" && s.latest)) ?? null
  );
}

async function teamLatest(page: Page, skillId: string): Promise<string | null> {
  return page.evaluate(
    async ({ skillId, teamKey }) => {
      const res = await fetch(`/v1/skills/catalog/${encodeURIComponent(skillId)}`, {
        headers: { "x-kobe-team": window.localStorage.getItem(teamKey) ?? "" },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { versions?: { semver: string }[] };
      return body.versions?.[0]?.semver ?? null;
    },
    { skillId, teamKey: TEAM_KEY },
  );
}

async function restore(page: Page, skillId: string, semver: string | null): Promise<void> {
  await page.evaluate(
    async ({ api, skillId, semver }) => {
      await fetch(`${api}/catalog-skills/${encodeURIComponent(skillId)}/draft`, {
        method: "DELETE",
      });
      if (semver)
        await fetch(
          `${api}/catalog/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(semver)}/withdraw`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ note: "KOBE-495 browser spec cleanup" }),
          },
        );
    },
    { api: API, skillId, semver },
  );
}

test("a site admin edits a catalog skill's SKILL.md and publishes it for the teams", async ({
  page,
}) => {
  const marker = `KOBE-495 e2e ${Date.now()}`;
  const panel = panelOf(page);
  await page.goto(TAGS);
  await expect(panel.getByRole("heading", { level: 1, name: "Skill tags" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const skill = await pickSkill(page);
  test.skip(!skill, "No team-published catalog skill on this Site (set KOBE_CATALOG_SKILL).");
  if (!skill) return;
  let published: string | null = null;

  try {
    await panel.getByRole("link", { name: `Open ${skill.name}: files, versions and edit` }).click();
    await expect(
      panel.getByRole("heading", { level: 1, name: new RegExp(skill.name) }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    // The newest version's files, read-only.
    await expect(panel.getByRole("button", { name: "SKILL.md", exact: true })).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(panel.getByLabel("SKILL.md frontmatter")).toContainText(skill.name);

    await panel
      .getByRole("button", { name: `Edit ${skill.name} from ${skill.latest ?? ""}`, exact: true })
      .click();
    const replace = page.getByRole("alertdialog", { name: /Replace the site draft/ });
    if (await replace.isVisible().catch(() => false))
      await replace.getByRole("button", { name: "Replace draft" }).click();
    await expect(panel.getByRole("heading", { level: 1, name: `Edit ${skill.name}` })).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });

    const body = panel.getByLabel("Instructions (SKILL.md body)");
    await body.fill(`${await body.inputValue()}\n\n${marker}\n`);
    await expect(panel.getByText("All changes saved.")).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    // Persisted: a reload shows the edit.
    await page.reload();
    await expect(panel.getByLabel("Instructions (SKILL.md body)")).toHaveValue(new RegExp(marker), {
      timeout: SHELL_TIMEOUT_MS,
    });

    await panel.getByRole("button", { name: "Save version", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Publish ${skill.name} as a new version` });
    const version = dialog.getByRole("textbox", { name: /Version/ });
    await expect(version).not.toHaveValue("", { timeout: SHELL_TIMEOUT_MS });
    const semver = await version.inputValue();
    await dialog.getByRole("textbox", { name: /Changelog/ }).fill("KOBE-495 browser spec edit.");
    await dialog.getByRole("button", { name: "Publish version", exact: true }).click();
    await expect(panel.getByText(new RegExp(`Published ${skill.name} ${semver}`))).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    published = semver;

    // The team's catalog lists it as the newest version.
    expect(await teamLatest(page, skill.id)).toBe(semver);
  } finally {
    await restore(page, skill.id, published);
  }
});
