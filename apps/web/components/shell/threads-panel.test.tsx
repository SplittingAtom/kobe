// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { composer, openApp } from "../chat/testing";

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
  waitFor(() => expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull(), WAIT);

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

  it("searches the titles, ignoring case and accents, across every group", async () => {
    fake.addThread("Café budget");
    fake.addThread("Hiring plan");
    const old = fake.addThread("Old budget");
    must(fake.threads.get(old)).deleted_at = "2026-10-01T10:00:00.000Z";
    const { user, dialog } = await openOn();
    await within(dialog).findByRole("button", { name: "Hiring plan" }, WAIT);
    await user.type(within(dialog).getByLabelText("Search threads"), "CAFE");
    expect(within(dialog).getByRole("button", { name: "Café budget" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Hiring plan" })).toBeNull();
    await user.clear(within(dialog).getByLabelText("Search threads"));
    await user.type(within(dialog).getByLabelText("Search threads"), "budget");
    // A match in Trash shows too, its group opened.
    expect(within(dialog).getByRole("button", { name: "Restore Old budget" })).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Search threads"), " nothing");
    expect(within(dialog).getByText("No threads match “budget nothing”.")).toBeTruthy();
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
