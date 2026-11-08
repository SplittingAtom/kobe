import { expect, test, type Page } from "@playwright/test";
import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-564: Create kobe.skill.yaml with a model, against a real deployment, both ways in. From
 * the Promote panel: a personal version uploaded without a manifest is refused (`no_manifest`),
 * Kobe drafts the file with the team default model and the Workbench opens on the new draft with
 * it in place. From the editor: a fresh draft gets one under its file tree. Each flow spends one
 * model call on `KOBE_USER`'s budget and deletes the draft it made; the personal skill version
 * stays (there is no delete for versions). Run on gate1: `npx playwright test skill-manifest`.
 */
const STAMP = Date.now().toString(36);
const PROMOTED = `e2e-manifest-${STAMP}`;
const DRAFTED = `e2e-manifest-draft-${STAMP}`;
const TEAM_KEY = "kobe.lastTeamId";

const skillMd = (name: string) =>
  [
    "---",
    `name: ${name}`,
    `description: Builds the weekly ${name} sales summary from a CSV. Use when asked for a sales summary.`,
    "---",
    `# ${name}`,
    "",
    "Read the CSV with pandas, total the `amount` column by region and write the table as Markdown.",
    "",
  ].join("\n");

/** Deletes the draft open in the editor (its page), landing on the Workbench tab. */
async function deleteOpenDraft(page: Page, name: string): Promise<void> {
  await panelOf(page).getByRole("button", { name: "Delete draft" }).click();
  await page
    .getByRole("alertdialog", { name: `Delete the draft ${name}?` })
    .getByRole("button", { name: "Delete draft" })
    .click();
  await expect(page).toHaveURL(/\/me\/skills\?tab=workbench$/);
}

/** The generated file as the editor shows it: the skill's name, the author's license, a summary. */
async function expectManifestOpen(page: Page, name: string): Promise<void> {
  const tree = panelOf(page).getByRole("navigation", { name: "Files" });
  await expect(tree.getByRole("button", { name: "kobe.skill.yaml" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await tree.getByRole("button", { name: "kobe.skill.yaml" }).click();
  const contents = panelOf(page).getByLabel("Contents of kobe.skill.yaml");
  await expect(contents).toHaveValue(/apiVersion: kobe\.dev\/skill\/v1/, {
    timeout: SHELL_TIMEOUT_MS,
  });
  const text = await contents.inputValue();
  expect(text).toContain(`name: ${name}`);
  expect(text).toContain("license: Proprietary");
  expect(text).toMatch(/\nsummary: .+/);
  // Never the model's to decide: the manifest has no maintainers, and one version line.
  expect(text).not.toContain("maintainers:");
  expect(text.match(/^version: /gm)).toHaveLength(1);
}

test("Promote to Site: a version without a manifest gets one from the team model, in a new draft", async ({
  page,
}) => {
  await page.goto("/me/skills?tab=mine");
  await expect(panelOf(page).getByRole("heading", { level: 1, name: "Skills" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  // A personal version with SKILL.md alone (the upload takes a bare SKILL.md as text/markdown).
  const upload = await page.evaluate(
    async ({ md, teamKey }) => {
      const res = await fetch("/v1/skills?scope=personal", {
        method: "POST",
        headers: {
          "content-type": "text/markdown",
          "x-kobe-team": window.localStorage.getItem(teamKey) ?? "",
        },
        body: md,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    { md: skillMd(PROMOTED), teamKey: TEAM_KEY },
  );
  expect(upload.status, JSON.stringify(upload.body)).toBe(201);
  const semver = (upload.body as { version: { semver: string } }).version.semver;

  await page.reload();
  await panelOf(page)
    .getByRole("button", { name: `Promote ${PROMOTED} v${semver} to the Site` })
    .click();
  const promote = panelOf(page).getByRole("group", { name: "Promote to Site" });
  await expect(promote.getByRole("alert")).toContainText("needs a kobe.skill.yaml", {
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(promote.getByRole("button", { name: "Promote" })).toBeDisabled();
  const create = promote.getByRole("group", { name: "Create kobe.skill.yaml" });
  const model = create.getByRole("combobox", { name: "Model for the manifest" });
  await expect(model).toBeEnabled({ timeout: SHELL_TIMEOUT_MS });
  await expect(model.locator("option").first()).toHaveText(/^Team default \(.+\)$/);
  await expect(create.getByRole("combobox", { name: "License" })).toHaveValue("Proprietary");
  await create.getByRole("button", { name: "Create kobe.skill.yaml" }).click();
  // One real model call, then the Workbench editor on the new draft.
  await expect(page).toHaveURL(/\/me\/skills\/drafts\/[0-9a-f-]{36}/, {
    timeout: RUN_TIMEOUT_MS,
  });
  await expect(panelOf(page).getByRole("heading", { level: 1, name: PROMOTED })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expectManifestOpen(page, PROMOTED);
  await deleteOpenDraft(page, PROMOTED);
});

test("the Workbench editor writes kobe.skill.yaml into an open draft", async ({ page }) => {
  await page.goto("/me/skills?tab=workbench");
  await panelOf(page).getByLabel("Skill name").fill(DRAFTED);
  await panelOf(page).getByRole("button", { name: "Start a draft" }).click();
  await expect(panelOf(page).getByRole("heading", { level: 1, name: DRAFTED })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await panelOf(page)
    .getByLabel("Description")
    .fill(`Builds the weekly ${DRAFTED} sales summary. Use when asked for a sales summary.`);
  await expect(panelOf(page).getByText("All changes saved.")).toBeVisible({ timeout: 5_000 });

  const create = panelOf(page).getByRole("group", { name: "Create kobe.skill.yaml" });
  await expect(create.getByRole("combobox", { name: "Model for the manifest" })).toBeEnabled({
    timeout: SHELL_TIMEOUT_MS,
  });
  await create.getByRole("button", { name: "Create kobe.skill.yaml" }).click();
  await expect(
    panelOf(page).getByText(
      /^kobe\.skill\.yaml written by .+\.$|starts from the SKILL\.md description\.$/,
    ),
  ).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  // The offer is spent; the file is in the tree and open.
  await expect(panelOf(page).getByRole("group", { name: "Create kobe.skill.yaml" })).toHaveCount(0);
  await expectManifestOpen(page, DRAFTED);
  // It survives a reload (it is a draft file like any other).
  await page.reload();
  await expectManifestOpen(page, DRAFTED);
  await deleteOpenDraft(page, DRAFTED);
});
