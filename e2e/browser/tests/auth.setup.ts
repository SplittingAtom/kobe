import { expect, test as setup } from "@playwright/test";
import { SHELL_TIMEOUT_MS, STORAGE_STATE } from "./support/constants.js";

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
  // KOBE_TEAM (a team slug) pins the team the specs run in: a fresh sign-in otherwise lands in
  // the first of the user's teams by name, which need not be the one with models enabled. Only
  // after the first load: the switcher's own activation would otherwise overwrite it.
  const slug = process.env["KOBE_TEAM"];
  if (slug) {
    const teamId = await page.evaluate(async (want) => {
      const res = await fetch("/v1/me/teams");
      const body = (await res.json()) as { teams: { id: string; slug: string }[] };
      const id = body.teams.find((t) => t.slug === want)?.id;
      if (!id) return null;
      const put = await fetch("/v1/me/teams/active", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: id }),
      });
      if (!put.ok) return null;
      window.localStorage.setItem("kobe.lastTeamId", id);
      return id;
    }, slug);
    if (!teamId) throw new Error(`KOBE_TEAM=${slug}: not one of your teams`);
    await page.reload();
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const res = await fetch("/v1/me/teams");
            return ((await res.json()) as { activeTeamId: string | null }).activeTeamId;
          }),
        { timeout: SHELL_TIMEOUT_MS },
      )
      .toBe(teamId);
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("kobe.lastTeamId")), {
        timeout: SHELL_TIMEOUT_MS,
      })
      .toBe(teamId);
  }
  await page.context().storageState({ path: STORAGE_STATE });
});
