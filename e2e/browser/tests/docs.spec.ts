import { expect, test } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";

/**
 * KOBE-616: the Kobe guide. The bar's Docs icon opens /docs in the same tab; the nav opens a page;
 * a relative link in a page leads to another page; and the agent-facing text (/llms.txt, one
 * linked .md page, /llms-full.txt) is readable from a fresh context with no session. No model
 * turn, nothing created on the server.
 */
test("Docs opens the guide from the bar, and agents read it without a session", async ({
  chat,
  page,
  browser,
}) => {
  await chat.open();
  const firstRow = page.getByRole("banner").locator('[data-bar-row="1"]');
  await firstRow.getByRole("link", { name: "Docs" }).click();
  await expect(page).toHaveURL(/\/docs$/, { timeout: SHELL_TIMEOUT_MS });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("guide");
  await expect(page.getByText("/llms.txt", { exact: true })).toBeVisible();

  // A page from the nav, then a relative link in its body.
  const nav = page.getByRole("navigation", { name: "Guide" });
  await nav.getByRole("link", { name: "Getting started" }).click();
  await expect(page).toHaveURL(/\/docs\/getting-started$/);
  await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
  await expect(page.getByRole("link", { name: "View as Markdown" })).toHaveAttribute(
    "href",
    "/docs/getting-started.md",
  );
  const bodyLink = page.locator('[data-kobe-guide-body] a[href^="/docs/"]').first();
  const target = (await bodyLink.getAttribute("href")) ?? "";
  expect(target).toMatch(/^\/docs\/[a-z0-9/-]+(#.*)?$/);
  await bodyLink.click();
  await expect(page).toHaveURL(new RegExp(`${target.split("#")[0]}(#.*)?$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

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
