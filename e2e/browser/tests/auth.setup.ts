import { expect, test as setup } from "@playwright/test";
import { SHELL_TIMEOUT_MS, STORAGE_STATE } from "./support/constants.js";
import { pinTeam } from "./support/team.js";

/** Signs in once with the password form and saves the session (cookies, the team in storage). */
setup("sign in", async ({ page }) => {
  const user = process.env["KOBE_USER"];
  const password = process.env["KOBE_PW"];
  if (!user || !password) throw new Error("KOBE_USER and KOBE_PW are required");

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
    timeout: SHELL_TIMEOUT_MS,
  });

  // The chat records the active team on first load; the specs reuse it.
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  // The specs send that team as x-kobe-team on changes: save only once it is stored (the chat
  // stores it after activating, which can end after the composer shows).
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("kobe.lastTeamId")), {
      timeout: SHELL_TIMEOUT_MS,
    })
    .toMatch(/^[0-9a-f-]{36}$/);
  // KOBE_TEAM pins the team the specs run in (support/team.ts).
  await pinTeam(page);
  await page.context().storageState({ path: STORAGE_STATE });
});
