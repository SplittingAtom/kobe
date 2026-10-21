import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "../support/constants.js";
import { expect, FILES_TOGGLE, test, type Chat } from "../support/chat.js";
import {
  preferences,
  putPreferences,
  regions,
  secondBrowser,
  toolTurn,
  widthOf,
} from "../support/gate5.js";

/**
 * Gate 5, U17 (KOBE-227): "The CE7 table holds at four window widths in e2e; the conversation
 * column never measures under 400 px; rail state, divider and artifact width persist across two
 * browsers for the same user." One artifact is open in the column throughout.
 */
const SLACK_PX = 1;
/** CE7's bands: ≥ 1100 wide, 820–1100 medium, 768–820 overlay, < 768 one column (CE8). */
const WIDTHS = [
  { width: 1280, band: "wide" },
  { width: 960, band: "medium" },
  { width: 800, band: "overlay" },
  { width: 390, band: "single" },
] as const;

async function openArtifact(chat: Chat, title: string) {
  await chat.send(
    toolTurn("create_artifact", {
      kind: "html",
      title,
      content: `<!doctype html><html><body><h1>${title}</h1></body></html>`,
    }),
  );
  await chat.threadId(); // create_artifact never asks (PROMPT_EXEMPT_KOBE_TOOLS)
  await chat.waitForIdle();
}

test("U17: the CE7 table holds at 1280, 960, 800 and 390 px, the conversation never under 400 px", async ({
  chat,
  page,
}) => {
  const { rail, artifact, conversation } = regions(page);
  await chat.open();
  const title = `G5 layout ${Date.now().toString(36)}`;
  await openArtifact(chat, title);
  // The agent's artifact opens by itself as the column's active tab (CE6).
  await expect(artifact.getByRole("tab").first()).toBeVisible({ timeout: RUN_TIMEOUT_MS });

  for (const { width, band } of WIDTHS) {
    await test.step(`${width} px (${band})`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await expect(chat.composer).toBeInViewport();
      const conv = await widthOf(conversation);
      if (band === "single") {
        // One column: the conversation is the page; the rail is a drawer.
        expect(conv).toBeGreaterThanOrEqual(width - 32); // its own padding aside
        await expect(rail.locator("[data-rail-header]")).toBeHidden();
        return;
      }
      expect(conv).toBeGreaterThanOrEqual(400 - SLACK_PX);
      const railPx = await widthOf(rail);
      if (band === "wide") {
        expect(railPx).toBeGreaterThanOrEqual(200 - SLACK_PX); // expanded (280 by default)
        expect(await widthOf(artifact)).toBeGreaterThanOrEqual(360 - SLACK_PX);
      } else {
        // Medium and overlay: the rail collapses to 48 px.
        expect(Math.abs(railPx - 48)).toBeLessThanOrEqual(SLACK_PX);
      }
      if (band === "medium") expect(await widthOf(artifact)).toBeGreaterThanOrEqual(360 - SLACK_PX);
      if (band === "overlay") {
        // Opened here, the artifact is a sheet over the conversation, which keeps its 400 px.
        await page
          .getByRole("navigation", { name: "Artifacts in this conversation" })
          .getByRole("button", { name: title })
          .click();
        await expect(artifact).toHaveAttribute("data-sheet-open", "");
        expect(["absolute", "fixed"]).toContain(
          await artifact.evaluate((el) => getComputedStyle(el).position),
        );
        expect(await widthOf(conversation)).toBeGreaterThanOrEqual(400 - SLACK_PX);
        await page.keyboard.press("Escape");
      }
    });
  }
});

test("U17: rail state (width, tab, section) and artifact width persist across two browsers", async ({
  chat,
  page,
  browser,
}) => {
  const before = await (async () => {
    await chat.open();
    return preferences(page);
  })();
  const { rail, artifact } = regions(page);
  const second = await secondBrowser(browser);
  try {
    const title = `G5 persist ${Date.now().toString(36)}`;
    await openArtifact(chat, title);
    await expect(artifact.getByRole("tab").first()).toBeVisible({ timeout: RUN_TIMEOUT_MS });

    // The artifact column: Home is its 360 px floor.
    const columnHandle = page.getByRole("separator", {
      name: "Resize the artifact column and the conversation",
    });
    await columnHandle.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => widthOf(artifact)).toBeLessThanOrEqual(360 + SLACK_PX);
    // The rail (CE7's "rail state and divider" since KOBE-453/448: the threads are a panel and
    // the rail is one Files | Apps section): its width, its tab where the team has apps, then
    // collapsed (Mod+B).
    const railHandle = page.getByRole("separator", { name: "Resize the workspace rail" });
    await railHandle.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => widthOf(rail)).toBeLessThanOrEqual(200 + SLACK_PX);
    const appsTab = page
      .getByRole("tablist", { name: "Files and apps" })
      .getByRole("tab", { name: "Apps", exact: true });
    const tabs = await appsTab.isVisible();
    if (tabs) await appsTab.click();
    await page.locator("body").press("ControlOrMeta+b");
    await expect.poll(() => widthOf(rail)).toBeLessThanOrEqual(48 + SLACK_PX);

    // Stored on the server for the member (CE8), not in this browser.
    await expect.poll(async () => (await preferences(page))["rail_collapsed"]).toBe(true);
    await expect.poll(async () => (await preferences(page))["rail_width"]).toBe(200);
    await expect
      .poll(async () => (await preferences(page))["artifact_width"])
      .toBeLessThanOrEqual(360 + SLACK_PX);
    if (tabs) await expect.poll(async () => (await preferences(page))["rail_tab"]).toBe("apps");

    // The second browser, signed in on its own, gets the same layout: collapsed, then expanded
    // at the same width on the same tab.
    await second.reload();
    await expect(second.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    const r2 = regions(second);
    await expect.poll(() => widthOf(r2.rail)).toBeLessThanOrEqual(48 + SLACK_PX);
    await second.locator("body").press("ControlOrMeta+b");
    await expect.poll(() => widthOf(r2.rail)).toBeGreaterThan(200 - SLACK_PX);
    if (tabs) {
      const tabs2 = second.getByRole("tablist", { name: "Files and apps" });
      await expect(tabs2.getByRole("tab", { name: "Apps", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      // A live picker on the Apps tab widens the shown rail to 400 px, unsaved (KOBE-460/461):
      // the member's own 200 px shows on Files (the tab is restored below).
      await tabs2.getByRole("tab", { name: "Files", exact: true }).click();
    }
    await expect.poll(() => widthOf(r2.rail)).toBeLessThanOrEqual(200 + SLACK_PX);

    // The section's visibility: hidden here, the rail is its strip there too.
    await page.locator("body").press("ControlOrMeta+b");
    const filesToggle = page
      .locator("[data-rail-header]")
      .getByRole("button", { name: FILES_TOGGLE });
    await filesToggle.click();
    await expect.poll(() => widthOf(rail)).toBeLessThanOrEqual(48 + SLACK_PX);
    await expect.poll(async () => (await preferences(page))["rail_panels"]).toBe("threads");
    await second.reload();
    await expect(second.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect.poll(() => widthOf(r2.rail)).toBeLessThanOrEqual(48 + SLACK_PX);
    await expect(second.locator("#kobe-rail-files")).toBeHidden();

    // The artifact width applies once a column opens there: the same thread's artifact, reopened
    // from the thread's artifact list (the open set itself is per browser, CE6).
    await second.goto(page.url());
    await second
      .getByRole("navigation", { name: "Artifacts in this conversation" })
      .getByRole("button", { name: title })
      .click();
    await expect(r2.artifact.getByRole("tab").first()).toBeVisible();
    await expect.poll(() => widthOf(r2.artifact)).toBeLessThanOrEqual(360 + SLACK_PX);
  } finally {
    await second.context().close();
    await putPreferences(page, {
      rail_collapsed: before["rail_collapsed"] ?? false,
      artifact_width: before["artifact_width"] ?? null,
      rail_panels: before["rail_panels"] ?? "both",
      rail_width: before["rail_width"] ?? null,
      rail_tab: before["rail_tab"] ?? "files",
    });
  }
});
