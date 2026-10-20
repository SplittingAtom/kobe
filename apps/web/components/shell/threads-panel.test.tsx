// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { composer, openApp, openRowMenu } from "../chat/testing";

/**
 * KOBE-453: the threads leave the rail for a Threads panel over the workspace (KOBE-452's large
 * centred overlay), with search, the groups and a collapsed Trash; choosing a thread opens it and
 * closes the panel. The row menus, keyboard and drag onto a project run here too (thread-menu,
 * thread-organize and thread-share tests open this panel).
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

const rail = () => screen.getByRole("complementary", { name: "Workspace" });
const threadsButton = () => within(rail()).getByRole("button", { name: "Threads panel" });
const panel = () => screen.findByRole("dialog", { name: "Threads" }, WAIT);
const closed = () =>
  waitFor(() => expect(document.querySelector('[data-kobe-panel="threads"]')).toBeNull(), WAIT);

async function openOn(threadId?: string) {
  openApp(fake, threadId);
  await composer();
  const user = userEvent.setup();
  await user.click(threadsButton());
  return { user, dialog: await panel() };
}

describe("the Threads panel (ac-1, ac-5)", () => {
  it("opens from the rail over the workspace, at /threads, with the groups and counts", async () => {
    fake.addThread("Budget");
    fake.addThread("Hiring plan");
    const { user, dialog } = await openOn();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("data-kobe-panel")).toBe("threads");
    expect(window.location.pathname).toBe("/threads");
    // The workspace stays mounted underneath, inert.
    expect(screen.getByLabelText("Message").closest("[inert]")).not.toBeNull();
    const again = dialog;
    const yours = await within(again).findByRole("button", { name: "Your threads" }, WAIT);
    expect(yours.textContent).toContain("2");
    // Escape closes it; focus returns to Threads.
    within(again).getByLabelText("Search threads").focus();
    await user.keyboard("{Escape}");
    await closed();
    expect(window.location.pathname).toBe("/");
    await waitFor(() => expect(document.activeElement).toBe(threadsButton()));
  });

  it("searches with the server (?q=), the hits as rows with their menu, and what matched", async () => {
    fake.addThread("Quarterly budget");
    fake.addThread("Hiring plan");
    const { user, dialog } = await openOn();
    await within(dialog).findByRole("button", { name: "Hiring plan" }, WAIT);
    await user.type(within(dialog).getByLabelText("Search threads"), "budget");
    const hits = within(await within(dialog).findByRole("list", { name: "Search results" }, WAIT));
    await waitFor(() =>
      expect(fake.requests.some((r) => r.path === "/v1/threads?q=budget")).toBe(true),
    );
    // One request for the whole word: the field waits for the last key.
    expect(fake.requests.filter((r) => r.path.startsWith("/v1/threads?q=b"))).toHaveLength(1);
    expect(hits.getAllByRole("listitem")).toHaveLength(1);
    expect(hits.getByRole("button", { name: "Quarterly budget" })).toBeTruthy();
    // The same row as in its group: its ⋯ menu, and the snippet under it.
    expect(hits.getByRole("button", { name: "Actions for Quarterly budget" })).toBeTruthy();
    expect(hits.getByText("Quarterly budget", { selector: "mark" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Hiring plan" })).toBeNull();
    await user.type(within(dialog).getByLabelText("Search threads"), " nothing");
    expect(
      await within(dialog).findByText("No threads match “budget nothing”.", {}, WAIT),
    ).toBeTruthy();
    await user.clear(within(dialog).getByLabelText("Search threads"));
    expect(await within(dialog).findByRole("button", { name: "Hiring plan" }, WAIT)).toBeTruthy();
  });

  it("a hit the list has not read yet still opens, closing the panel", async () => {
    fake.addThread("Near");
    const { user, dialog } = await openOn();
    await within(dialog).findByRole("button", { name: "Near" }, WAIT);
    // Made since the list was read (as one further down its pages): only the server knows it.
    const t = fake.addThread("Far back");
    await user.type(within(dialog).getByLabelText("Search threads"), "far");
    const hits = within(await within(dialog).findByRole("list", { name: "Search results" }, WAIT));
    const row = await hits.findByRole("button", { name: "Far back" }, WAIT);
    expect(hits.queryByRole("button", { name: "Actions for Far back" })).toBeNull();
    await user.click(row);
    await closed();
    await waitFor(() => expect(window.location.search).toBe(`?thread=${t}`));
  });

  it("choosing a thread opens it and closes the panel; Back returns to the one before", async () => {
    const a = fake.addThread("Alpha");
    const b = fake.addThread("Beta");
    const { user, dialog } = await openOn(a);
    await user.click(await within(dialog).findByRole("button", { name: "Beta" }, WAIT));
    await closed();
    await waitFor(() => expect(window.location.search).toBe(`?thread=${b}`));
    expect(window.location.pathname).toBe("/");
    expect(await screen.findByRole("heading", { level: 2, name: "Beta" }, WAIT)).toBeTruthy();
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe(`?thread=${a}`));
    expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull();
  });

  it("choosing the thread already open closes the panel onto it", async () => {
    const a = fake.addThread("Alpha");
    const { user, dialog } = await openOn(a);
    await user.click(await within(dialog).findByRole("button", { name: "Alpha" }, WAIT));
    await closed();
    expect(window.location.search).toBe(`?thread=${a}`);
  });

  it("a link or a reload at /threads opens it over the last thread", async () => {
    const a = fake.addThread("Alpha");
    sessionStorage.setItem("kobe.lastThread", JSON.stringify({ teamId: fake.teamId, threadId: a }));
    openApp(fake, undefined, undefined, "");
    act(() => {
      window.history.replaceState(null, "", "/threads");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await panel()).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 2, name: "Alpha" }, WAIT)).toBeTruthy();
  });

  it("is a full-screen dialog on a phone, opened from the drawer", async () => {
    resizeWindow(390);
    fake.addThread("Alpha");
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show the workspace" }));
    const drawer = await screen.findByRole("dialog", { name: "Workspace" });
    await user.click(within(drawer).getByRole("button", { name: "Threads panel" }));
    const dialog = await panel();
    expect(within(dialog).getByRole("button", { name: "Close Threads" })).toBeTruthy();
  });
});

describe("Trash (ac-2)", () => {
  it("is collapsed by default; opened, its rows restore or delete forever", async () => {
    const old = fake.addThread("Old idea");
    must(fake.threads.get(old)).deleted_at = "2026-10-01T10:00:00.000Z";
    fake.addThread("Current");
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const { user, dialog } = await openOn();
    const trash = await within(dialog).findByRole("button", { name: "Trash" }, WAIT);
    expect(trash.getAttribute("aria-expanded")).toBe("false");
    expect(within(dialog).queryByRole("button", { name: "Restore Old idea" })).toBeNull();
    await user.click(trash);
    const list = within(within(dialog).getByRole("list", { name: "Trash" }));
    expect(list.getByRole("button", { name: "Delete Old idea forever" })).toBeTruthy();
    await user.click(list.getByRole("button", { name: "Restore Old idea" }));
    await waitFor(() => expect(fake.threads.get(old)?.deleted_at).toBeNull(), WAIT);
    // Restoring opens nothing: the panel stays, on the same thread (review M5).
    expect(screen.getByRole("dialog", { name: "Threads" })).toBe(dialog);
    expect(window.location.pathname).toBe("/threads");
    expect(await within(dialog).findByRole("button", { name: "Old idea" }, WAIT)).toBeTruthy();
  });
});

describe("New conversation (ac-4)", () => {
  it("sits immediately left of Threads on the top line", async () => {
    openApp(fake);
    await composer();
    const line = must(rail().querySelector<HTMLElement>("[data-rail-header]"));
    const labels = [...line.querySelectorAll<HTMLElement>("button, a")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels.indexOf("Threads panel")).toBe(labels.indexOf("New conversation") + 1);
  });
});

describe("actions from the panel (review M5)", () => {
  it("Regenerate opens its thread and closes the panel onto it; Copy keeps it open", async () => {
    const a = fake.addThread("Alpha");
    const b = fake.addThread("Budget");
    const root = fake.addSystemEntry(b, null, "thinking_level_change", { thinkingLevel: "off" });
    const u = fake.addEntry(b, root, { role: "user", content: "sum it" });
    const answer = fake.addEntry(b, u, {
      role: "assistant",
      content: [{ type: "text", text: "42" }],
    });
    must(fake.threads.get(b)).leaf_entry_id = answer;
    const { user } = await openOn(a);
    const copy = await openRowMenu("Actions for Budget");
    await user.click(within(copy).getByRole("menuitem", { name: "Copy" }));
    expect(await screen.findByText("Copied “Budget” as Markdown.", {}, WAIT)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Threads" })).toBeTruthy();
    const regen = await openRowMenu("Actions for Budget");
    await user.click(within(regen).getByRole("menuitem", { name: "Regenerate" }));
    await closed();
    await waitFor(() => expect(window.location.search).toBe(`?thread=${b}`));
  });
});

describe("the Threads button's activity (review M4)", () => {
  it("shows a dot while any conversation runs, named for screen readers", async () => {
    const t = fake.addThread("Report");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "go{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined(), WAIT);
    const button = await within(rail()).findByRole(
      "button",
      { name: "Threads panel, a conversation is running" },
      WAIT,
    );
    expect(button.getAttribute("data-kobe-activity")).toBe("running");
    expect(button.querySelector("[data-badge]")).not.toBeNull();
  });

  it("has no dot while nothing runs", async () => {
    fake.addThread("Quiet");
    openApp(fake);
    await composer();
    expect(threadsButton().getAttribute("data-kobe-activity")).toBe("idle");
    expect(threadsButton().querySelector("[data-badge]")).toBeNull();
  });
});

describe("on a phone (review L7)", () => {
  it("focus goes back to the drawer's Threads after Escape; choosing closes panel and drawer", async () => {
    resizeWindow(390);
    const t = fake.addThread("Alpha");
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show the workspace" }));
    const drawer = await screen.findByRole("dialog", { name: "Workspace" });
    const threads = within(drawer).getByRole("button", { name: "Threads panel" });
    await user.click(threads);
    const dialog = await panel();
    within(dialog).getByLabelText("Search threads").focus();
    await user.keyboard("{Escape}");
    await closed();
    await waitFor(() => expect(document.activeElement).toBe(threads));
    expect(screen.getByRole("dialog", { name: "Workspace" })).toBeTruthy();
    await user.click(threads);
    await user.click(await within(await panel()).findByRole("button", { name: "Alpha" }, WAIT));
    await closed();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    expect(window.location.search).toBe(`?thread=${t}`);
  });
});
