import { expect, test } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";

/**
 * KOBE-616: the Kobe guide. The bar's Docs icon opens /docs as a panel over the workspace, the way
 * the Site console opens (KOBE-452); the nav opens a page and a relative link in a page leads to
 * another, both inside the panel; Escape closes it and focus is back on the icon. The agent-facing
 * text (/llms.txt, one linked .md page, /llms-full.txt) is readable from a fresh context with no
 * session. No model turn, nothing created on the server.
 */
test("Docs opens the guide in a panel from the bar, and agents read it without a session", async ({
  chat,
  page,
  browser,
}) => {
  await chat.open();
  const conversation = page.locator("#kobe-chat-main");
  const firstRow = page.getByRole("banner").locator('[data-bar-row="1"]');
  const icon = firstRow.getByRole("link", { name: "Docs" });
  await icon.click();
  await expect(page).toHaveURL(/\/docs$/, { timeout: SHELL_TIMEOUT_MS });
  const panel = page.getByRole("dialog", { name: "Docs" });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-kobe-panel", "docs");
  // The workspace stays mounted underneath.
  await expect(conversation).toBeAttached();
  await expect(panel.getByRole("heading", { level: 1 })).toContainText("guide");
  await expect(panel.getByText("/llms.txt", { exact: true })).toBeVisible();

  // A page from the nav, then a relative link in its body: the panel stays open.
  const nav = panel.getByRole("navigation", { name: "Guide" });
  await nav.getByRole("link", { name: "Getting started" }).click();
  await expect(page).toHaveURL(/\/docs\/getting-started$/);
  await expect(panel.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "View as Markdown" })).toHaveAttribute(
    "href",
    "/docs/getting-started.md",
  );
  const bodyLink = panel.locator('[data-kobe-guide-body] a[href^="/docs/"]').first();
  const target = (await bodyLink.getAttribute("href")) ?? "";
  expect(target).toMatch(/^\/docs\/[a-z0-9/-]+(#.*)?$/);
  await bodyLink.click();
  await expect(page).toHaveURL(new RegExp(`${target.split("#")[0]}(#.*)?$`));
  await expect(panel.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);

  // Escape closes it onto the conversation; focus is back on the Docs icon.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/docs/);
  await expect(conversation).toBeAttached();
  await expect(icon).toBeFocused();

  // The agent-facing text, from a context with no cookies.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const api = context.request;
    const index = await api.get("/llms.txt");
    expect(index.status()).toBe(200);
    expect(index.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    const text = await index.text();
    expect(text).toMatch(/^# .+\n\n> .+/);
    const linked = /\]\((https?:\/\/[^)]+\/docs\/[^)]+\.md)\)/.exec(text)?.[1];
    expect(linked, "llms.txt links a page").toBeTruthy();

    const md = await api.get(new URL(linked as string).pathname);
    expect(md.status()).toBe(200);
    expect(md.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(await md.text()).toMatch(/^# .+/);

    const full = await api.get("/llms-full.txt");
    expect(full.status()).toBe(200);
    expect(full.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    expect(await full.text()).toContain("Source: ");
  } finally {
    await context.close();
  }
});
