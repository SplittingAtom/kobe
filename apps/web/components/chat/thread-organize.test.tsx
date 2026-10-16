// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THREAD_DRAG_TYPE } from "../../lib/chat/organize";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { openApp, openRowMenu } from "./testing";

/**
 * KOBE-220 (CE19): Pin, Archive and Move to project from a row's ⋯ menu (and Move by dragging a
 * row onto a project header). The rail's groups follow at once and after a reload; a refused move
 * says why; the run after a move is marked in the conversation; search marks archived threads.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The titles of each rail group (only open groups list their rows). */
function groups(): [string, string[]][] {
  return [...document.querySelectorAll<HTMLElement>("[data-group]")].map((g) => [
    g.dataset.group ?? "",
    [...g.querySelectorAll("[data-kobe-thread]")].map(
      (row) => row.querySelector("button")?.textContent ?? "",
    ),
  ]);
}

async function choose(menuName: string, item: string) {
  const menu = await openRowMenu(menuName);
  await userEvent.setup().click(within(menu).getByRole("menuitem", { name: item }));
}

/**
 * Opens a submenu by keyboard (happy-dom has no layout for Radix's pointer grace area between the
 * menus), once its choices are read (until then the item says it is loading).
 */
async function submenu(menuName: string, item: string): Promise<HTMLElement> {
  const menu = await openRowMenu(menuName);
  const trigger = await waitFor(() => {
    const found = within(menu).getByRole("menuitem", { name: item });
    expect(found.getAttribute("aria-disabled"), found.getAttribute("title") ?? "").toBeNull();
    return found;
  });
  trigger.focus();
  await userEvent.setup().keyboard("{ArrowRight}");
  return screen.findByRole("menu", { name: item });
}

const status = () => document.querySelector("[data-kobe-rail-status]")?.textContent ?? "";

describe("pin and archive (ac-1)", () => {
  it("pins a thread to the top group and back, kept after a reload", async () => {
    fake.addThread("Budget");
    fake.addThread("Plan");
    openApp(fake);
    await screen.findByRole("button", { name: "Actions for Budget" });
    expect(groups()).toEqual([["ungrouped", ["Plan", "Budget"]]]);

    await choose("Actions for Budget", "Pin");
    await waitFor(() =>
      expect(groups()).toEqual([
        ["pinned", ["Budget"]],
        ["ungrouped", ["Plan"]],
      ]),
    );
    await waitFor(() => expect(status()).toBe("Pinned “Budget”."));

    cleanup();
    openApp(fake);
    await screen.findByRole("button", { name: "Actions for Budget" });
    expect(groups()[0]).toEqual(["pinned", ["Budget"]]);

    const menu = await openRowMenu("Actions for Budget");
    expect(within(menu).queryByRole("menuitem", { name: "Pin" })).toBeNull();
    await userEvent.setup().click(within(menu).getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(groups()).toEqual([["ungrouped", ["Plan", "Budget"]]]));
  });

  it("archives into the folded Archived group and unarchives from it", async () => {
    fake.addThread("Budget");
    fake.addThread("Plan");
    openApp(fake);
    await choose("Actions for Budget", "Archive");
    await waitFor(() =>
      expect(groups()).toEqual([
        ["ungrouped", ["Plan"]],
        ["archived", []],
      ]),
    );
    const toggle = within(
      must(document.querySelector<HTMLElement>('[data-group="archived"]')),
    ).getByRole("button", { expanded: false });
    expect(toggle.textContent).toContain("Archived");
    // The row went into a folded group: the focus goes to that group's toggle.
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    fireEvent.click(toggle);
    const menu = await openRowMenu("Actions for Budget");
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(names).toEqual(expect.arrayContaining(["Move to project", "Unarchive", "Delete"]));
    expect(names).not.toContain("Archive");
    expect(names).not.toContain("Pin");
    await userEvent.setup().click(within(menu).getByRole("menuitem", { name: "Unarchive" }));
    await waitFor(() => expect(groups()).toEqual([["ungrouped", ["Plan", "Budget"]]]));
  });

  it("reads the list again when another tab changes a thread", async () => {
    const t = fake.addThread("Budget");
    const posted: ((id: string) => void)[] = [];
    const sync = {
      post: vi.fn(),
      subscribe: (listener: (id: string) => void) => {
        posted.push(listener);
        return () => undefined;
      },
      close: vi.fn(),
    };
    window.history.replaceState(null, "", "/");
    const { ChatApp } = await import("./chat-app");
    const { render } = await import("@testing-library/react");
    render(
      <ChatApp fetchFn={fake.fetch} eventSource={fake.eventSource} threadListSync={() => sync} />,
    );
    await screen.findByRole("button", { name: "Actions for Budget" });
    must(fake.threads.get(t)).pinned_at = "2026-10-03T10:00:00.000Z"; // pinned in the other tab
    for (const listener of posted) listener(t);
    await waitFor(() => expect(groups()).toEqual([["pinned", ["Budget"]]]));
    await choose("Actions for Budget", "Unpin");
    await waitFor(() => expect(sync.post).toHaveBeenCalledWith(t));
  });
});

describe("move to project (ac-2)", () => {
  it("lists the member's projects and moves the thread under its project", async () => {
    const q4 = fake.addProject("Q4");
    fake.addProject("Ops");
    fake.addThread("Budget");
    openApp(fake);
    const sub = await submenu("Actions for Budget", "Move to project");
    expect(
      within(sub)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["No project (current)", "Q4", "Ops"]);
    within(sub).getByRole("menuitem", { name: "Q4" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(groups()).toEqual([["project", ["Budget"]]]));
    expect(fake.threads.get(fake.threads.keys().next().value ?? "")?.project_id).toBe(q4);
    await waitFor(() =>
      expect(status()).toBe("Moved “Budget” to Q4. Its instructions apply from the next message."),
    );
  });

  it("says why a move was refused, and the thread stays where it was", async () => {
    fake.addProject("Q4");
    fake.addThread("Budget");
    openApp(fake);
    fake.refuseOrganize = {
      status: 404,
      code: "project_not_found",
      message: "No project with that id is available to you.",
    };
    const sub = await submenu("Actions for Budget", "Move to project");
    within(sub).getByRole("menuitem", { name: "Q4" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() =>
      expect(status()).toBe(
        "You can't start conversations in that project, so this one can't move there.",
      ),
    );
    expect(await screen.findByText("Not moved")).toBeTruthy();
    expect(groups()).toEqual([["ungrouped", ["Budget"]]]);
  });

  it("moves a row dropped on a project header", async () => {
    const q4 = fake.addProject("Q4");
    const plan = fake.addThread("Plan");
    must(fake.threads.get(plan)).project_id = q4;
    const budget = fake.addThread("Budget");
    openApp(fake);
    await screen.findByRole("button", { name: "Actions for Budget" });
    await waitFor(() => expect(groups()[0]?.[0]).toBe("project"));
    const row = must(document.querySelector(`[data-kobe-thread="${budget}"]`));
    expect(row.getAttribute("draggable")).toBe("true");
    const data = new Map<string, string>();
    const dataTransfer = {
      types: [THREAD_DRAG_TYPE],
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(row, { dataTransfer });
    const header = within(
      must(document.querySelector<HTMLElement>('[data-group="project"]')),
    ).getByRole("button", { expanded: true });
    fireEvent.dragOver(header, { dataTransfer });
    expect(header.dataset.dropTarget).toBe("true");
    fireEvent.drop(header, { dataTransfer });
    await waitFor(() => expect(fake.threads.get(budget)?.project_id).toBe(q4));
    await waitFor(() => expect(groups()).toEqual([["project", ["Budget", "Plan"]]]));
  });

  it("marks the run after a move in the conversation", async () => {
    const t = fake.addThread("Budget");
    const u1 = fake.addEntry(t, null, { role: "user", content: "before" });
    const a1 = fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a" }] });
    const u2 = fake.addEntry(t, a1, { role: "user", content: "after the move" });
    fake.addEntry(t, u2, { role: "assistant", content: [{ type: "text", text: "b" }] });
    fake.threadMarkers.set(t, {
      runs: [],
      approvals: [],
      projects: [
        {
          run_id: "00000000-0000-4000-8000-000000000099",
          user_entry_id: u2,
          parent_entry_id: a1,
          from_project_id: null,
          from_project_name: null,
          to_project_id: "00000000-0000-4000-8000-000000000098",
          to_project_name: "Q4",
        },
      ],
    });
    openApp(fake, t);
    const marker = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-kobe-marker="project"]')),
    );
    expect(marker.getAttribute("role")).toBe("note");
    expect(marker.textContent).toContain("Moved to project Q4");
    expect(marker.textContent).toContain("its instructions apply from here");
  });
});

describe("search (ac-3)", () => {
  it("still finds archived threads, marked as archived", async () => {
    const t = fake.addThread("Budget");
    must(fake.threads.get(t)).archived_at = "2026-10-03T10:00:00.000Z";
    openApp(fake);
    const search = await screen.findByRole("searchbox", { name: /search/i });
    const user = userEvent.setup();
    await user.type(search, "budget{Enter}");
    const hits = await screen.findByRole("list", { name: "Search results" });
    expect(within(hits).getByRole("button", { name: "Budget" })).toBeTruthy();
    expect(within(hits).getByText("Archived")).toBeTruthy();
  });
});
