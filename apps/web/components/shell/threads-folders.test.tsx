// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import {
  chooseNode,
  closeThreads,
  composer,
  openApp,
  openRowMenu,
  openThreads,
} from "../chat/testing";

/**
 * KOBE-536 (spec TF6, TF7, TF12): the Threads panel's two rails. The folder tree (Current with
 * Archived folded under it, the team's folders, Deleted) beside the chosen node's threads; the
 * folder actions; the phone dropdown; the node remembered while the tab lives.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  resizeWindow(DESKTOP_WIDTH);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const nodes = (panel: HTMLElement) =>
  within(panel)
    .getAllByRole("treeitem")
    .map((n) => [n.getAttribute("aria-label"), n.getAttribute("aria-level"), n.textContent]);

const rowsIn = (panel: HTMLElement) =>
  [...panel.querySelectorAll<HTMLElement>("[data-kobe-thread] button")]
    .filter((b) => !b.getAttribute("aria-label"))
    .map((b) => b.textContent);

const groupsIn = (panel: HTMLElement) =>
  [...panel.querySelectorAll<HTMLElement>("[data-group]")].map((g) => g.dataset.group);

function file(threadId: string, folderId: string, more: Record<string, unknown> = {}) {
  Object.assign(must(fake.threads.get(threadId)), { folder_id: folderId, ...more });
}

async function open() {
  openApp(fake);
  await composer();
  return openThreads();
}

describe("the tree and the folder views (ac-1)", () => {
  it("orders Current (Archived folded under it), the folders, Deleted; with counts", async () => {
    const a = fake.folders.add("Alpha");
    fake.folders.add("Sub", a);
    fake.folders.add("Beta");
    file(fake.addThread("Filed"), a);
    file(fake.addThread("Filed archived"), a, { archived_at: "2026-10-03T10:00:00.000Z" });
    fake.addThread("Loose");
    must(fake.threads.get(fake.addThread("Gone"))).deleted_at = "2026-10-01T10:00:00.000Z";
    const panel = await open();
    await waitFor(() =>
      expect(nodes(panel)).toEqual([
        ["Current", "1", "Current11 thread"],
        ["Alpha", "1", "Alpha11 thread"],
        ["Beta", "1", "Beta00 threads"],
        ["Deleted", "1", "Deleted11 thread"],
      ]),
    );
    const tree = within(panel).getByRole("tree", { name: "Thread folders" });
    expect(
      within(tree).getByRole("treeitem", { name: "Current" }).getAttribute("aria-selected"),
    ).toBe("true");
    // Current's chevron shows Archived, which counts every archived thread.
    fireEvent.click(
      must(within(tree).getByRole("treeitem", { name: "Current" }).querySelector("button")),
    );
    expect(nodes(panel).map((n) => n[0])).toEqual([
      "Current",
      "Archived",
      "Alpha",
      "Beta",
      "Deleted",
    ]);
    expect(
      within(tree).getByRole("treeitem", { name: "Archived" }).getAttribute("aria-level"),
    ).toBe("2");
    expect(within(tree).getByRole("treeitem", { name: "Archived" }).textContent).toContain("1");
    // Alpha's chevron shows Sub.
    fireEvent.click(
      must(within(tree).getByRole("treeitem", { name: "Alpha" }).querySelector("button")),
    );
    expect(within(tree).getByRole("treeitem", { name: "Sub" }).getAttribute("aria-level")).toBe(
      "2",
    );
  });

  it("Current excludes filed and archived threads; a folder shows its own, Shared with me too", async () => {
    const a = fake.folders.add("Alpha");
    const p = fake.addProject("Website");
    file(fake.addThread("Filed plain"), a);
    file(fake.addThread("Filed pinned"), a, { pinned_at: "2026-10-03T10:00:00.000Z" });
    file(fake.addThread("Filed in project"), a, { project_id: p });
    file(fake.addThread("Filed shared"), a, {
      read_only: true,
      visibility: "team",
      owner_name: "Al",
    });
    file(fake.addThread("Filed archived"), a, { archived_at: "2026-10-03T10:00:00.000Z" });
    fake.addThread("Loose");
    fake.addThread("Loose archived").valueOf();
    must([...fake.threads.values()].at(-1)).archived_at = "2026-10-03T10:00:00.000Z";
    const panel = await open();
    await within(panel).findByRole("button", { name: "Loose" }, WAIT);
    expect(rowsIn(panel)).toEqual(["Loose"]);
    expect(groupsIn(panel)).toEqual(["ungrouped"]);
    await chooseNode("Alpha");
    await within(panel).findByRole("button", { name: "Filed plain" }, WAIT);
    expect(groupsIn(panel)).toEqual(["pinned", "project", "ungrouped", "shared"]);
    expect(rowsIn(panel)).toEqual([
      "Filed pinned",
      "Filed in project",
      "Filed plain",
      "Filed shared",
    ]);
    expect(within(panel).queryByRole("button", { name: "Filed archived" })).toBeNull();
    expect(fake.requests.some((r) => r.path === `/v1/threads?folder=${a}`)).toBe(true);
  });

  it("Archived lists every archived thread with its folder path; Unarchive returns it there", async () => {
    const a = fake.folders.add("Alpha");
    const sub = fake.folders.add("Sub", a);
    file(fake.addThread("Filed archived"), sub, { archived_at: "2026-10-03T10:00:00.000Z" });
    must(fake.threads.get(fake.addThread("Loose archived"))).archived_at =
      "2026-10-04T10:00:00.000Z";
    const panel = await open();
    await chooseNode("Archived");
    const list = within(await within(panel).findByRole("list", { name: "Archived" }, WAIT));
    await list.findByRole("button", { name: "Filed archived" }, WAIT);
    expect(rowsIn(panel)).toEqual(["Loose archived", "Filed archived"]);
    expect(list.getByText("In Alpha / Sub")).toBeTruthy();
    expect(list.getAllByText(/^In /u)).toHaveLength(1);
    const menu = await openRowMenu("Actions for Filed archived");
    await userEvent.setup().click(within(menu).getByRole("menuitem", { name: "Unarchive" }));
    await waitFor(
      () => expect(list.queryByRole("button", { name: "Filed archived" })).toBeNull(),
      WAIT,
    );
    fireEvent.click(
      must(within(panel).getByRole("treeitem", { name: "Alpha" }).querySelector("button")),
    );
    await chooseNode("Sub");
    expect(await within(panel).findByRole("button", { name: "Filed archived" }, WAIT)).toBeTruthy();
  });

  it("an empty folder with subfolders points at the tree", async () => {
    const a = fake.folders.add("Alpha");
    fake.folders.add("Sub", a);
    await open();
    const panel = await chooseNode("Alpha");
    expect(
      await within(panel).findByText("No threads here. Its folders are in the tree.", {}, WAIT),
    ).toBeTruthy();
  });

  it("moves through the tree with the arrows, Home/End and type-ahead; Enter chooses", async () => {
    fake.folders.add("Alpha");
    fake.folders.add("Beta");
    const panel = await open();
    const tree = within(panel);
    const current = await tree.findByRole("treeitem", { name: "Current" });
    await tree.findByRole("treeitem", { name: "Beta" }, WAIT);
    current.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(tree.getByRole("treeitem", { name: "Alpha" }));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(tree.getByRole("treeitem", { name: "Deleted" }));
    await user.keyboard("{Home}b");
    expect(document.activeElement).toBe(tree.getByRole("treeitem", { name: "Beta" }));
    await user.keyboard("{Enter}");
    expect(tree.getByRole("treeitem", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Home}{ArrowRight}");
    expect(tree.getByRole("treeitem", { name: "Archived" })).toBeTruthy();
  });
});

describe("folder actions (ac-2)", () => {
  /** Opens a submenu by keyboard (happy-dom has no layout for Radix's pointer grace area). */
  async function moveTo(menu: HTMLElement, target: string) {
    within(menu).getByRole("menuitem", { name: "Move to…" }).focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}");
    const sub = await screen.findByRole("menu", { name: "Move to…" });
    await user.click(within(sub).getByRole("menuitem", { name: target }));
  }

  async function folderMenu(panel: HTMLElement, name: string) {
    const button = await within(panel).findByRole("button", { name: `Actions for ${name}` }, WAIT);
    await userEvent.setup().click(button);
    return screen.findByRole("menu", { name: `Actions for ${name}` });
  }

  it("creates a folder inline; a taken name is refused inline", async () => {
    fake.folders.add("Alpha");
    const panel = await open();
    const user = userEvent.setup();
    await user.click(within(panel).getByRole("button", { name: "+ New folder" }));
    await user.type(
      within(panel).getByRole("textbox", { name: "New folder name" }),
      "alpha{Enter}",
    );
    expect((await within(panel).findByRole("alert", {}, WAIT)).textContent).toBe(
      "A folder with that name is already there. Choose another name.",
    );
    const field = within(panel).getByRole("textbox", { name: "New folder name" });
    await user.clear(field);
    await user.type(field, "Budgets{Enter}");
    expect(await within(panel).findByRole("treeitem", { name: "Budgets" }, WAIT)).toBeTruthy();
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(panel.querySelector("[data-kobe-rail-status]")?.textContent).toBe(
      "Created the folder “Budgets”.",
    );
  });

  it("renames inline, nests to three levels and refuses a fourth", async () => {
    const a = fake.folders.add("Alpha");
    const sub = fake.folders.add("Sub", a);
    fake.folders.add("Deep", sub);
    const panel = await open();
    const user = userEvent.setup();
    let menu = await folderMenu(panel, "Alpha");
    await user.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    const field = await within(panel).findByRole("textbox", { name: "Rename Alpha" });
    await user.clear(field);
    await user.type(field, "Money{Enter}");
    expect(await within(panel).findByRole("treeitem", { name: "Money" }, WAIT)).toBeTruthy();
    fireEvent.click(
      must(within(panel).getByRole("treeitem", { name: "Money" }).querySelector("button")),
    );
    fireEvent.click(
      must(within(panel).getByRole("treeitem", { name: "Sub" }).querySelector("button")),
    );
    menu = await folderMenu(panel, "Deep");
    const inside = within(menu).getByRole("menuitem", { name: "New folder inside" });
    expect(inside.getAttribute("aria-disabled")).toBe("true");
    expect(inside.getAttribute("title")).toBe("Folders go three levels deep");
  });

  it("moves a folder to another or the top level, and says when it is too deep", async () => {
    const a = fake.folders.add("Alpha");
    const b = fake.folders.add("Beta");
    fake.folders.add("Sub", b);
    const panel = await open();
    let menu = await folderMenu(panel, "Alpha");
    await moveTo(menu, "Beta");
    await waitFor(() => expect(fake.folders.folders.get(a)?.parent_id).toBe(b));
    expect(await within(panel).findByRole("treeitem", { name: "Alpha" }, WAIT)).toBeTruthy();
    expect(within(panel).getByRole("treeitem", { name: "Alpha" }).getAttribute("aria-level")).toBe(
      "2",
    );
    menu = await folderMenu(panel, "Alpha");
    await moveTo(menu, "Top level");
    await waitFor(() => expect(fake.folders.folders.get(a)?.parent_id).toBeNull());
    // The server's refusal shows inline (another member nested a folder meanwhile).
    fake.failNext.set(
      `PATCH /v1/thread-folders/${a}`,
      Response.json(
        { code: "folder_too_deep", message: "Folders go three levels deep." },
        { status: 409 },
      ),
    );
    menu = await folderMenu(panel, "Alpha");
    await moveTo(menu, "Beta");
    expect((await within(panel).findByRole("alert", {}, WAIT)).textContent).toBe(
      "Folders go three levels deep.",
    );
  });

  it("deletes a folder and its folders after confirming; its threads go back to Current", async () => {
    const a = fake.folders.add("Alpha");
    const s1 = fake.folders.add("One", a);
    fake.folders.add("Two", a);
    const t = fake.addThread("Filed");
    file(t, s1);
    const panel = await open();
    await chooseNode("Alpha");
    const user = userEvent.setup();
    const menu = await folderMenu(panel, "Alpha");
    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    const confirm = within(await within(panel).findByRole("group", { name: "Delete folder" }));
    expect(
      confirm.getByText(
        "Delete “Alpha” and its 2 folders? The threads in them go back to their owners' Current.",
      ),
    ).toBeTruthy();
    await user.click(confirm.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(fake.folders.folders.size).toBe(0));
    expect(fake.threads.get(t)?.folder_id).toBeNull();
    await waitFor(() =>
      expect(
        within(panel).getByRole("treeitem", { name: "Current" }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(await within(panel).findByRole("button", { name: "Filed" }, WAIT)).toBeTruthy();
  });
});

describe("on a phone (ac-4)", () => {
  it("the tree is a dropdown above the list with every node, New folder and the folder menu", async () => {
    resizeWindow(390);
    const a = fake.folders.add("Alpha");
    fake.folders.add("Sub", a);
    file(fake.addThread("Filed"), a);
    fake.addThread("Loose");
    const panel = await open();
    expect(within(panel).queryByRole("tree")).toBeNull();
    const select = (await within(panel).findByRole(
      "combobox",
      { name: "Show threads in" },
      WAIT,
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect([...select.options].map((o) => o.textContent)).toEqual([
        "Current (1)",
        "   Archived (0)",
        "Alpha (1)",
        "   Sub (0)",
        "Deleted (0)",
      ]),
    );
    const user = userEvent.setup();
    await user.selectOptions(select, `folder:${a}`);
    expect(await within(panel).findByRole("button", { name: "Filed" }, WAIT)).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Loose" })).toBeNull();
    // The chosen folder's own menu sits beside it.
    await user.click(within(panel).getByRole("button", { name: "Actions for Alpha" }));
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(within(panel).getByRole("button", { name: "+ New folder" }));
    await user.type(within(panel).getByRole("textbox", { name: "New folder name" }), "Beta{Enter}");
    await waitFor(() =>
      expect([...select.options].map((o) => o.textContent)).toContain("Beta (0)"),
    );
  });
});

describe("the chosen node (ac-6)", () => {
  it("is remembered while the tab lives, never stored", async () => {
    const a = fake.folders.add("Alpha");
    file(fake.addThread("Filed"), a);
    fake.addThread("Loose");
    const panel = await open();
    await within(panel).findByRole("treeitem", { name: "Alpha" }, WAIT);
    await chooseNode("Alpha");
    await within(panel).findByRole("button", { name: "Filed" }, WAIT);
    await closeThreads();
    const again = await openThreads();
    await waitFor(() =>
      expect(
        within(again).getByRole("treeitem", { name: "Alpha" }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(await within(again).findByRole("button", { name: "Filed" }, WAIT)).toBeTruthy();
    const stored = (store: Storage) =>
      Array.from(
        { length: store.length },
        (_, i) => `${store.key(i)}=${store.getItem(store.key(i) ?? "")}`,
      );
    expect([...stored(localStorage), ...stored(sessionStorage)].join("\n")).not.toMatch(
      new RegExp(`${a}|folder`, "u"),
    );
    expect(
      fake.requests.filter((r) => r.path.startsWith("/v1/me/preferences") && r.method !== "GET"),
    ).toEqual([]);
    // A new page (a reload) starts on Current again.
    cleanup();
    act(() => window.history.replaceState(null, "", "/"));
    const fresh = await open();
    await waitFor(() =>
      expect(
        within(fresh).getByRole("treeitem", { name: "Current" }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });
});
