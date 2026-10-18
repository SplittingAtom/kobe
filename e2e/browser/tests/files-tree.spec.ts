import type { Page } from "@playwright/test";
import { expect, test } from "./support/chat.js";

/**
 * KOBE-304: the rail's Files as a compact tree. Uploads three small files into a new folder of the
 * member's workspace, opens it in the tree (keyboard), checks the ARIA tree, the type icons and the
 * row height, screenshots the tree in light and dark (test-results/, for the before/after record),
 * renames a file with F2, moves it by drag and drop and with Move to…, and deletes the folder at
 * the end. No model tokens.
 */
const TEAM_KEY = "kobe.lastTeamId";
const THEME_COOKIE = "kobe-theme";

/** The member's own workspace API, called from the page (session cookie, CSRF Origin). */
async function api(
  page: Page,
  method: "POST" | "DELETE",
  path: string,
  content?: string,
): Promise<number> {
  return page.evaluate(
    async ({ method, path, content, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
      if (method === "DELETE") {
        const q = encodeURIComponent(path);
        return (await fetch(`/v1/workspace/files?path=${q}`, { method, headers })).status;
      }
      const slash = path.lastIndexOf("/");
      const form = new FormData();
      form.set("path", path.slice(0, slash));
      form.set("file", new File([content ?? ""], path.slice(slash + 1), { type: "text/plain" }));
      return (await fetch("/v1/workspace/files", { method, headers, body: form })).status;
    },
    { method, path, content, teamKey: TEAM_KEY },
  );
}

test("Files tree: open, keys, icons, light and dark, rename, drag to move, Move to…", async ({
  chat,
  page,
  context,
  baseURL,
}, testInfo) => {
  const dir = `kobe-304-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await chat.open();
  for (const [path, body] of [
    [`${dir}/sales.csv`, "a,b\n1,2\n"],
    [`${dir}/notes/plan.md`, "# Plan\n"],
    [`${dir}/script.py`, "print('hi')\n"],
  ] as const) {
    expect(await api(page, "POST", path, body)).toBe(201);
  }
  try {
    const files = page.getByRole("region", { name: "Files" });
    const openFiles = files.getByRole("button", { name: "Open files" });
    if (await openFiles.isVisible()) await openFiles.click();
    const tree = files.getByRole("tree", { name: "Files in your workspace" });
    const row = (name: string) => tree.getByRole("treeitem", { name, exact: true });
    await expect(row(dir)).toBeVisible();

    // Keyboard: focus the folder, open it with →, step in, type-ahead.
    await row(dir).click();
    await expect(row(dir)).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(row(dir)).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("ArrowRight");
    await expect(row("sales.csv")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(row("notes")).toBeFocused();
    // Type-ahead (WAI-ARIA tree): the next row after the focused one starting with the key, so
    // "s" from notes is sales.csv and "s" again is script.py (folders first, then names).
    await page.keyboard.press("s");
    await expect(row("sales.csv")).toBeFocused();
    await page.keyboard.press("s");
    await expect(row("script.py")).toBeFocused();
    await expect(row("sales.csv")).toHaveAttribute("aria-level", "2");

    // Compact rows with type icons; colour never carries the kind (it is in the description).
    expect((await row("sales.csv").boundingBox())?.height ?? 0).toBeLessThanOrEqual(26);
    await expect(row("sales.csv").locator("svg.lucide-file-spreadsheet")).toHaveCount(1);
    await expect(row("script.py").locator("svg.lucide-file-code")).toHaveCount(1);

    for (const theme of ["light", "dark"] as const) {
      await context.addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL ?? "" }]);
      await page.reload();
      // A load never lists Files on its own (listing wakes the sandbox): ask, as a member does,
      // once the rail has rendered.
      await expect(openFiles.or(row("sales.csv"))).toBeVisible();
      if (await openFiles.isVisible()) await openFiles.click();
      await expect(row("sales.csv")).toBeVisible(); // expansion is remembered
      await files.screenshot({ path: testInfo.outputPath(`files-tree-${theme}.png`) });
    }
    await context.clearCookies({ name: THEME_COOKIE });

    // Rename with F2. Focus the row without clicking it: a click opens the file in the artifact
    // column, which takes the focus (KOBE-268), so F2 would land there.
    await row("script.py").focus();
    await expect(row("script.py")).toBeFocused();
    await page.keyboard.press("F2");
    const rename = files.getByRole("dialog", { name: "Rename script.py" });
    await rename.getByRole("textbox").fill("tool.py");
    await page.keyboard.press("Enter");
    await expect(row("tool.py")).toBeFocused();

    // Drag onto a folder: it moves there.
    await row("tool.py").dragTo(row("notes"));
    await expect(row("tool.py")).toHaveAttribute("aria-level", "3");

    // Move to… from the row menu (the keyboard way): back to the folder's top.
    await row("tool.py").hover();
    await row("tool.py").getByRole("button", { name: "Actions for tool.py" }).click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    const move = files.getByRole("dialog", { name: "Move tool.py to" });
    await move.getByRole("radio", { name: dir, exact: true }).check();
    await move.getByRole("button", { name: "Move here" }).click();
    await expect(row("tool.py")).toHaveAttribute("aria-level", "2");

    // A clash is refused, never overwritten.
    expect(await api(page, "POST", `${dir}/notes/sales.csv`, "other")).toBe(201);
    await files.getByRole("button", { name: "Refresh files" }).click();
    await row("sales.csv").last().dragTo(row("notes")); // the top one, not notes/sales.csv
    await expect(files.getByRole("alert")).toContainText("already there");
  } finally {
    expect(await api(page, "DELETE", dir)).toBe(204);
  }
});
