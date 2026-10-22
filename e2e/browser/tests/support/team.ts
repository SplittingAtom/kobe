import { expect, type Page } from "@playwright/test";
import { SHELL_TIMEOUT_MS } from "./constants.js";

/**
 * KOBE_TEAM (a team slug) pins the team a signed-in page runs in. The active team belongs to the
 * session: a fresh sign-in lands in the user's last active team (else the first working team with
 * a model, KOBE-456), which need not be the team the specs use; pinning also makes it the last. Call it after the chat's first load (the
 * switcher's own activation would otherwise overwrite it); without KOBE_TEAM it does nothing.
 * Every page that signs in on its own (the setup, a second browser) calls it (KOBE-457).
 */
export async function pinTeam(page: Page): Promise<void> {
  const slug = process.env["KOBE_TEAM"];
  if (!slug) return;
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
