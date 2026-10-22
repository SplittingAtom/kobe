import type { Locator, Page } from "@playwright/test";
import { expect, filesSection, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS } from "./support/constants.js";
import { styleViolations, watchStyleViolations } from "./support/csp.js";

/**
 * KOBE-465 (spec docs/specs/notebooks.md; run with KOBE_TEAM=team1): a notebook of the member's
 * workspace opens in the artifact column; Start wakes the sandbox and starts the conversation's
 * kernel without running code (KOBE-477), then Restart takes its place; a cell is added and typed, and runs in the
 * conversation's kernel with state carried from the cell before (x = 1, then x + 1 gives 2); a
 * matplotlib figure shows as an image, a DataFrame as a table; a sleeping cell is interrupted
 * and the kernel restarted; after a reload the saved notebook still holds the outputs. CodeMirror
 * and the outputs raise no style-src CSP violation. One short model turn creates the thread.
 */
const TEAM_KEY = "kobe.lastTeamId";

const code = (id: string, source: string) => ({
  cell_type: "code",
  id,
  metadata: {},
  execution_count: null,
  source,
  outputs: [],
});

const NOTEBOOK = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
  cells: [
    { cell_type: "markdown", id: "intro", metadata: {}, source: "# KOBE-465 check" },
    code("setx", "x = 1"),
    code("plot", "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3], [1, 4, 9])\nplt.show()"),
    code("frame", "import pandas as pd\npd.DataFrame({'a': [1, 2], 'b': ['p', 'q']})"),
    code("sleep", "import time\ntime.sleep(300)"),
  ],
};

/** The member's own workspace from the page: upload, read or delete. */
async function workspace(
  page: Page,
  op: "upload" | "delete" | "read",
  path: string,
  content = "",
): Promise<{ status: number; text: string }> {
  return page.evaluate(
    async ({ op, path, content, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
      const q = encodeURIComponent(path);
      if (op === "delete") {
        const res = await fetch(`/v1/workspace/files?path=${q}`, { method: "DELETE", headers });
        return { status: res.status, text: "" };
      }
      if (op === "upload") {
        const slash = path.lastIndexOf("/");
        const form = new FormData();
        form.set("path", path.slice(0, slash));
        form.set("file", new File([content], path.slice(slash + 1), { type: "application/json" }));
        const res = await fetch("/v1/workspace/files", { method: "POST", headers, body: form });
        return { status: res.status, text: "" };
      }
      const read = await fetch(`/v1/workspace/file?path=${q}`, { headers });
      return { status: read.status, text: await read.text() };
    },
    { op, path, content, teamKey: TEAM_KEY },
  );
}

async function openNotebook(page: Page, dir: string): Promise<Locator> {
  const files = filesSection(page);
  await files.getByRole("button", { name: "Refresh files" }).click();
  const tree = files.getByRole("tree", { name: "Files in your workspace" });
  // The tree remembers an expanded folder across a reload: open it only when it is closed.
  const folder = tree.getByRole("treeitem", { name: dir, exact: true });
  if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
  await tree.getByRole("treeitem", { name: "check.ipynb", exact: true }).click();
  const notebook = page.locator("[data-kobe-notebook]");
  await expect(notebook.getByRole("heading", { name: "KOBE-465 check" })).toBeVisible();
  return notebook;
}

const cell = (notebook: Locator, n: number) =>
  notebook.getByRole("region", { name: new RegExp(`^Cell ${n} `) });

/** Runs cell `n` and waits for the kernel to finish it. */
async function run(notebook: Locator, n: number): Promise<void> {
  await notebook.getByRole("button", { name: `Run cell ${n}`, exact: true }).click();
  await expect(cell(notebook, n).locator("[data-kobe-exec-count]")).toHaveText(/^\[\d+\]$/u, {
    timeout: RUN_TIMEOUT_MS,
  });
}

test("notebook: start, cells run with state, image and table outputs, interrupt, restart, saved outputs", async ({
  chat,
  page,
}) => {
  test.setTimeout(4 * RUN_TIMEOUT_MS);
  const dir = `kobe-465-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const path = `${dir}/check.ipynb`;
  await chat.open();
  await watchStyleViolations(page);
  expect((await workspace(page, "upload", path, JSON.stringify(NOTEBOOK))).status).toBe(201);
  try {
    // The kernel belongs to a conversation: one short turn creates it.
    await chat.ask("Reply with the single word OK.");
    let notebook = await openNotebook(page, dir);

    // Start (KOBE-477): the kernel comes up with nothing run (the first cell is then [1]), shown
    // step by step, and Restart takes Start's place.
    const start = notebook.getByRole("button", { name: "Start", exact: true });
    const kernelState = notebook.locator("[data-kobe-kernel]");
    await start.click();
    await expect(kernelState).toHaveText(/Waking sandbox…|Starting kernel…|Kernel idle/u);
    await expect(notebook.locator('[data-kobe-kernel="idle"]')).toHaveText("Kernel idle", {
      timeout: RUN_TIMEOUT_MS,
    });
    await expect(start).toHaveCount(0);
    await expect(notebook.getByRole("button", { name: "Restart", exact: true })).toBeVisible();

    // x = 1, then a new cell typed below it: x + 1 is 2 (Shift+Enter runs it).
    await run(notebook, 2);
    await expect(cell(notebook, 2).locator("[data-kobe-exec-count]")).toHaveText("[1]");
    await notebook.getByRole("button", { name: "Add a code cell below cell 2" }).click();
    const added = notebook.getByLabel("Code of cell 3");
    await added.click();
    await page.keyboard.type("x + 1");
    await page.keyboard.press("Shift+Enter");
    await expect(cell(notebook, 3).locator('[data-kobe-output="text"]')).toHaveText("2", {
      timeout: RUN_TIMEOUT_MS,
    });

    // A matplotlib figure is an image from a data: URL; a DataFrame is a table of text.
    await run(notebook, 4);
    const image = cell(notebook, 4).locator('img[data-kobe-output="image"]');
    await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/u);
    await run(notebook, 5);
    const table = cell(notebook, 5).getByRole("table");
    await expect(table.getByRole("columnheader", { name: "a", exact: true })).toBeVisible();
    await expect(table.getByRole("cell", { name: "q", exact: true })).toBeVisible();

    // A sleeping cell is interrupted; the kernel then restarts.
    await notebook.getByRole("button", { name: "Run cell 6", exact: true }).click();
    await expect(notebook.locator('[data-kobe-kernel="busy"]')).toBeVisible({
      timeout: RUN_TIMEOUT_MS,
    });
    await page.waitForTimeout(2_000); // the cell is sleeping in the kernel
    await notebook.getByRole("button", { name: "Interrupt", exact: true }).click();
    await expect(
      cell(notebook, 6)
        .getByText(/KeyboardInterrupt|Interrupted\./u)
        .first(),
    ).toBeVisible({
      timeout: RUN_TIMEOUT_MS,
    });
    await expect(notebook.locator('[data-kobe-kernel="idle"]')).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept());
    await notebook.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(notebook.getByText(/Kernel restarted|No kernel is running/u)).toBeVisible();
    await expect(notebook.getByRole("button", { name: "Start", exact: true })).toBeVisible();

    // The outputs were saved into the notebook: a reload shows them from the file.
    const saved = JSON.parse((await workspace(page, "read", path)).text) as {
      cells: { id: string; outputs?: unknown[] }[];
    };
    expect(saved.cells.map((c) => c.id).slice(0, 2)).toEqual(["intro", "setx"]);
    expect(saved.cells[2]?.outputs?.length).toBeGreaterThan(0);
    expect(await styleViolations(page)).toEqual([]);
    await page.reload();
    notebook = await openNotebook(page, dir);
    await expect(cell(notebook, 3).locator('[data-kobe-output="text"]')).toHaveText("2");
    await expect(cell(notebook, 4).locator('img[data-kobe-output="image"]')).toBeVisible();
    await expect(cell(notebook, 5).getByRole("table")).toBeVisible();
    await watchStyleViolations(page);
    await expect(notebook.locator("[data-kobe-code-editor]").first()).toBeVisible();
    expect(await styleViolations(page)).toEqual([]);
  } finally {
    expect((await workspace(page, "delete", dir)).status).toBe(204);
  }
});
