import { expect, test } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-321: the Skills page and the Workbench editor against a real deployment. The page renders
 * from the server (review B1: a server component calling a client module's function was a 500),
 * the retired editor URLs land on it, and a draft's edits autosave, lint and scan, and survive
 * leaving the editor at once by an in-app link (review B2). The spec starts one draft and deletes
 * it at the end; no model turn. `KOBE_USER` must be able to write skills in the active team.
 * Run on gate1: `npx playwright test skills-workbench`.
 */
const NAME = `e2e-workbench-${Date.now().toString(36)}`;

test("the Skills page loads from the server, on every tab", async ({ page }) => {
  for (const tab of ["catalog", "team", "mine", "workbench"]) {
    const res = await page.goto(`/me/skills?tab=${tab}`);
    expect(res?.status(), tab).toBe(200);
    await expect(panelOf(page).getByRole("heading", { level: 1, name: "Skills" })).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    const tabs = panelOf(page).getByRole("tablist", { name: "Skills" });
    await expect(tabs.getByRole("tab", { selected: true })).toHaveText(
      tab === "mine" ? "Mine" : tab[0]?.toUpperCase() + tab.slice(1),
    );
  }
});

test("the retired editor URLs land on the Skills page", async ({ page }) => {
  await page.goto("/me/skills/new");
  await expect(page).toHaveURL(/\/me\/skills\?tab=workbench$/);
  await page.goto("/admin/team/skills/new");
  await expect(page).toHaveURL(/\/me\/skills\?tab=workbench$/);
});

test("a draft autosaves, lints and scans, and keeps an edit made just before leaving", async ({
  page,
}) => {
  await page.goto("/me/skills?tab=workbench");
  await panelOf(page).getByLabel("Skill name").fill(NAME);
  await panelOf(page).getByRole("button", { name: "Start a draft" }).click();
  await expect(panelOf(page).getByRole("heading", { level: 1, name: NAME })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(panelOf(page).getByText(/^Scanned as saved \(revision \d+\)\.$/)).toBeVisible();

  const description = panelOf(page).getByLabel("Description");
  await description.fill("Writes test reports. Use when asked for a test report.");
  // Lint is immediate; the save and the scan of it follow within 2 s.
  await expect(
    panelOf(page).getByText(/^\d+ errors?, \d+ warnings?\.$|^No problems found\.$/),
  ).toBeVisible();
  await expect(panelOf(page).getByText("All changes saved.")).toBeVisible({ timeout: 2_000 });
  await expect(panelOf(page).getByText(/^Scanned as saved \(revision \d+\)\.$/)).toBeVisible({
    timeout: 2_000,
  });
  await expect(panelOf(page).getByText("Pass", { exact: true })).toBeVisible();

  // Leave by an in-app link straight after typing: the edit is written on the way out.
  await panelOf(page).getByLabel("Instructions (SKILL.md body)").fill("Kept while leaving.");
  await panelOf(page).getByRole("link", { name: "Workbench" }).first().click();
  await expect(panelOf(page).getByRole("tab", { name: "Workbench", selected: true })).toBeVisible();
  await panelOf(page).getByRole("link", { name: NAME }).click();
  await expect(panelOf(page).getByLabel("Instructions (SKILL.md body)")).toHaveValue(
    /Kept while leaving\./,
    { timeout: SHELL_TIMEOUT_MS },
  );

  await panelOf(page).getByRole("button", { name: "Delete draft" }).click();
  await page
    .getByRole("alertdialog", { name: `Delete the draft ${NAME}?` })
    .getByRole("button", { name: "Delete draft" })
    .click();
  await expect(page).toHaveURL(/\/me\/skills\?tab=workbench$/);
  await expect(panelOf(page).getByRole("link", { name: NAME })).toHaveCount(0);
});

test("Create file and New folder save a draft file that stays after a reload (KOBE-478)", async ({
  page,
}) => {
  const name = `${NAME}-files`;
  await page.goto("/me/skills?tab=workbench");
  await panelOf(page).getByLabel("Skill name").fill(name);
  await panelOf(page).getByRole("button", { name: "Start a draft" }).click();
  await expect(panelOf(page).getByRole("heading", { level: 1, name })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const tree = panelOf(page).getByRole("navigation", { name: "Files" });

  // A folder name is checked before it is shown; a valid one waits in the tree for a file.
  await tree.getByRole("button", { name: "New folder" }).click();
  await tree.getByLabel("Folder name").fill("../up");
  await tree.getByRole("button", { name: "Add folder" }).click();
  await expect(tree.getByText(/\.\. folder name/)).toBeVisible();
  await tree.getByLabel("Folder name").fill("templates/forms");
  await tree.getByRole("button", { name: "Add folder" }).click();
  await expect(tree.getByText("Empty until a file is saved in it.")).toBeVisible();

  await tree.getByRole("button", { name: "Create file in templates/forms" }).click();
  await expect(panelOf(page).getByLabel("New file path")).toHaveValue("templates/forms/");
  await panelOf(page).getByLabel("New file path").fill("templates/forms/intake.md");
  await panelOf(page).getByLabel("New file contents").fill("# Intake\nAsk for the client name.");
  await panelOf(page).getByRole("button", { name: "Save file" }).click();
  await expect(panelOf(page).getByLabel("Contents of templates/forms/intake.md")).toHaveValue(
    /Ask for the client name\./,
  );
  await expect(panelOf(page).getByText(/^Scanned as saved \(revision \d+\)\.$/)).toBeVisible({
    timeout: 2_000,
  });

  await page.reload();
  await panelOf(page)
    .getByRole("navigation", { name: "Files" })
    .getByRole("button", { name: "templates/forms/intake.md" })
    .click({ timeout: SHELL_TIMEOUT_MS });
  await expect(panelOf(page).getByLabel("Contents of templates/forms/intake.md")).toHaveValue(
    /Ask for the client name\./,
  );

  await panelOf(page).getByRole("button", { name: "Delete draft" }).click();
  await page
    .getByRole("alertdialog", { name: `Delete the draft ${name}?` })
    .getByRole("button", { name: "Delete draft" })
    .click();
  await expect(page).toHaveURL(/\/me\/skills\?tab=workbench$/);
});
