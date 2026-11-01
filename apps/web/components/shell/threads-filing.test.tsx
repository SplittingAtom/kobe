// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THREAD_DRAG_TYPE } from "../../lib/chat/organize";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { isMacPlatform } from "../../lib/shell/shortcuts";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { chooseNode, composer, openApp, openRowMenu, openThreads } from "../chat/testing";

/**
 * KOBE-536 (spec TF8, TF10): putting a thread in a folder from the row menu (own and shared
 * rows), the conversation's commands and drag onto a tree node; Remove from folder; the polite
 * announcement; the tree read again on focus; search hits with their folder path.
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

const status = (panel: HTMLElement) => panel.querySelector("[data-kobe-rail-status]")?.textContent;
const node = (panel: HTMLElement, name: string) => within(panel).getByRole("treeitem", { name });

/** Opens a row's Save to folder… submenu by keyboard, once the folders are read. */
async function saveMenu(rowName: string): Promise<HTMLElement> {
  const menu = await openRowMenu(`Actions for ${rowName}`);
  const trigger = await waitFor(() => {
    const found = within(menu).getByRole("menuitem", { name: "Save to folder…" });
    expect(found.getAttribute("aria-disabled")).toBeNull();
    return found;
  }, WAIT);
  trigger.focus();
  await userEvent.setup().keyboard("{ArrowRight}");
  return screen.findByRole("menu", { name: "Save to folder…" });
}

function dragData() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
}

async function open(threadId?: string) {
  openApp(fake, threadId);
  await composer();
  return openThreads();
}

describe("Save to folder (ac-3)", () => {
  it("files an own row from its menu: it leaves Current, the folder counts it, it is said", async () => {
    const f = fake.folders.add("Budgets");
    const sub = fake.folders.add("Q1", f);
    const t = fake.addThread("Budget");
    fake.addThread("Plan");
    const panel = await open();
    await within(panel).findByRole("button", { name: "Budget" }, WAIT);
    const sub1 = await saveMenu("Budget");
    const items = within(sub1).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Budgets", "Q1", "New folder…"]);
    // Folders indented by depth.
    expect(items[1]?.getAttribute("style")).toContain("padding-inline-start");
    await userEvent.setup().click(within(sub1).getByRole("menuitem", { name: "Q1" }));
    await waitFor(() => expect(fake.threads.get(t)?.folder_id).toBe(sub));
    expect(fake.requests.find((r) => r.path === `/v1/threads/${t}/file`)?.body).toEqual({
      folder_id: sub,
    });
    await waitFor(() => expect(status(panel)).toBe("Saved “Budget” to Q1."));
    await waitFor(() => expect(within(panel).queryByRole("button", { name: "Budget" })).toBeNull());
    expect(node(panel, "Current").textContent).toContain("1");
    // Remove from folder, from the folder's own list.
    fireEvent.click(must(node(panel, "Budgets").querySelector("button")));
    await chooseNode("Q1");
    await within(panel).findByRole("button", { name: "Budget" }, WAIT);
    await waitFor(() => expect(node(panel, "Q1").textContent).toContain("1"));
    const again = await saveMenu("Budget");
    expect(within(again).getByRole("menuitem", { name: "Q1 (current)" })).toBeTruthy();
    await userEvent
      .setup()
      .click(within(again).getByRole("menuitem", { name: "Remove from folder" }));
    await waitFor(() => expect(fake.threads.get(t)?.folder_id).toBeNull());
    await waitFor(() =>
      expect(status(panel)).toBe("Removed “Budget” from Budgets / Q1. It is in Current."),
    );
  });

  it("files a thread shared read-only with the member; New folder… creates one first", async () => {
    const t = fake.addThread("Theirs");
    Object.assign(must(fake.threads.get(t)), {
      read_only: true,
      visibility: "team",
      owner_name: "Alice Author",
    });
    const prompt = vi.fn(() => "Shared stuff");
    vi.stubGlobal("prompt", prompt);
    const panel = await open();
    await within(panel).findByRole("button", { name: "Theirs" }, WAIT);
    const sub = await saveMenu("Theirs");
    await userEvent.setup().click(within(sub).getByRole("menuitem", { name: "New folder…" }));
    await waitFor(() => expect(fake.threads.get(t)?.folder_id).toBeTruthy(), WAIT);
    expect(prompt).toHaveBeenCalledOnce();
    expect(fake.folders.folders.get(must(fake.threads.get(t)?.folder_id))?.name).toBe(
      "Shared stuff",
    );
    await waitFor(() => expect(status(panel)).toBe("Saved “Theirs” to Shared stuff."));
    await chooseNode("Shared stuff");
    const shared = await within(panel).findByRole("list", { name: "Shared with me" }, WAIT);
    expect(within(shared).getByRole("button", { name: "Theirs" })).toBeTruthy();
  });

  it("files the open thread from the command palette (the conversation's commands)", async () => {
    const f = fake.folders.add("Budgets");
    const t = fake.addThread("Budget");
    openApp(fake, t);
    await composer();
    await screen.findByRole("heading", { level: 2, name: "Budget" }, WAIT);
    const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "k", code: "KeyK", ...mod });
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const user = userEvent.setup();
    await user.keyboard("save to folder");
    await waitFor(() => {
      const options = within(dialog).getAllByRole("option");
      expect(options[0]?.getAttribute("aria-label")).toBe("Save to folder");
    }, WAIT);
    await user.keyboard("{Enter}");
    await within(dialog).findByRole("option", { name: "Budgets" }, WAIT);
    await user.keyboard("Budgets{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.folder_id).toBe(f), WAIT);
    // Filed, it left Current's list; the conversation stays on screen.
    await waitFor(() =>
      expect(
        fake.requests.filter((r) => r.path === "/v1/threads?folder=none").length,
      ).toBeGreaterThan(1),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(window.location.search).toBe(`?thread=${t}`);
    expect(screen.getByRole("heading", { level: 2, name: "Budget" })).toBeTruthy();
    expect(screen.getByLabelText("Message")).toBeTruthy();
  });

  it("files by dragging a row onto a tree node; Current takes it out; shared rows never onto a project", async () => {
    const f = fake.folders.add("Budgets");
    const p = fake.addProject("Website");
    fake.addThread("Site");
    must(fake.threads.get([...fake.threads.keys()].at(-1) ?? "")).project_id = p;
    const t = fake.addThread("Budget");
    const s = fake.addThread("Theirs");
    Object.assign(must(fake.threads.get(s)), { read_only: true, visibility: "team" });
    const panel = await open();
    await within(panel).findByRole("button", { name: "Budget" }, WAIT);
    const row = must(panel.querySelector(`[data-kobe-thread="${t}"]`));
    let data = dragData();
    fireEvent.dragStart(row, { dataTransfer: data });
    const target = node(panel, "Budgets");
    fireEvent.dragOver(target, { dataTransfer: data });
    expect(target.hasAttribute("data-drop-target")).toBe(true);
    // Archived and Deleted take no drop.
    fireEvent.dragOver(node(panel, "Deleted"), { dataTransfer: data });
    expect(node(panel, "Deleted").hasAttribute("data-drop-target")).toBe(false);
    fireEvent.drop(target, { dataTransfer: data });
    await waitFor(() => expect(fake.threads.get(t)?.folder_id).toBe(f));
    await waitFor(() => expect(status(panel)).toBe("Saved “Budget” to Budgets."));
    // A shared row drags (for folders) but a project header refuses it.
    const sharedRow = must(panel.querySelector(`[data-kobe-thread="${s}"]`));
    expect(sharedRow.getAttribute("draggable")).toBe("true");
    data = dragData();
    fireEvent.dragStart(sharedRow, { dataTransfer: data });
    const header = within(
      must(panel.querySelector<HTMLElement>('[data-group="project"]')),
    ).getByRole("button", { expanded: true });
    fireEvent.dragOver(header, { dataTransfer: data });
    expect(header.dataset.dropTarget).toBeUndefined();
    // Dropping a filed row on Current takes it out of its folder.
    await chooseNode("Budgets");
    const filed = await waitFor(() => must(panel.querySelector(`[data-kobe-thread="${t}"]`)), WAIT);
    data = dragData();
    fireEvent.dragStart(filed, { dataTransfer: data });
    fireEvent.dragOver(node(panel, "Current"), { dataTransfer: data });
    fireEvent.drop(node(panel, "Current"), { dataTransfer: data });
    await waitFor(() => expect(fake.threads.get(t)?.folder_id).toBeNull());
    expect(data.getData(THREAD_DRAG_TYPE)).toBe(t);
  });

  it("reads the tree again on window focus: another member's new folder appears", async () => {
    fake.folders.add("Mine");
    const panel = await open();
    await within(panel).findByRole("treeitem", { name: "Mine" }, WAIT);
    fake.folders.add("From a colleague");
    expect(within(panel).queryByRole("treeitem", { name: "From a colleague" })).toBeNull();
    act(() => window.dispatchEvent(new Event("focus")));
    expect(
      await within(panel).findByRole("treeitem", { name: "From a colleague" }, WAIT),
    ).toBeTruthy();
  });
});

describe("search (ac-5)", () => {
  it("finds filed threads, shows their folder path; choosing a hit closes the panel onto it", async () => {
    const f = fake.folders.add("Budgets");
    const sub = fake.folders.add("Q1", f);
    const t = fake.addThread("Quarterly budget");
    must(fake.threads.get(t)).folder_id = sub;
    fake.addThread("Hiring plan");
    const panel = await open();
    await within(panel).findByRole("treeitem", { name: "Budgets" }, WAIT);
    const user = userEvent.setup();
    await user.type(within(panel).getByLabelText("Search threads"), "budget");
    const hits = within(await within(panel).findByRole("list", { name: "Search results" }, WAIT));
    expect(await hits.findByText("In Budgets / Q1", {}, WAIT)).toBeTruthy();
    // The results replace the list only: the tree stays.
    expect(within(panel).getByRole("tree", { name: "Thread folders" })).toBeTruthy();
    await user.click(hits.getByRole("button", { name: "Quarterly budget" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull(), WAIT);
    await waitFor(() => expect(window.location.search).toBe(`?thread=${t}`));
  });
});
