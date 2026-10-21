// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, openApp, openRowMenu, openThreads, threadGroup } from "./testing";

/**
 * KOBE-466: a thread row in the Threads panel shows a trash icon on hover and keyboard focus that
 * moves the thread to Trash, the same action as the row menu's Delete (KOBE-292): no confirm, a
 * refusal shown beside the row. It does not open the thread, and Trash rows and threads shared
 * with the member read-only have none. Touch screens keep the menu as the way there.
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

const list = () => threadGroup("Your threads");
const trashButton = (root: HTMLElement, title: string) =>
  within(root).findByRole("button", { name: `Move ${title} to Trash` });

describe("thread row trash icon (KOBE-466)", () => {
  it("is revealed on row hover and focus, hidden on touch screens (ac-1)", async () => {
    fake.addThread("Budget");
    openApp(fake);
    const button = await trashButton(await list(), "Budget");
    expect(button.getAttribute("data-command")).toBe("trash-thread");
    const cls = button.className;
    expect(cls).toContain("group-hover/row:");
    expect(cls).toContain("group-focus-within/row:");
    // No hover on touch: hidden there, the ⋯ menu stays the way to Trash.
    expect(cls).toMatch(/(^|\s)hidden(\s|$)/u);
    expect(cls).toContain("pointer-fine:inline-flex");
  });

  it("names the action in a tooltip (ac-3)", async () => {
    fake.addThread("Budget");
    openApp(fake);
    const button = await trashButton(await list(), "Budget");
    await userEvent.setup().hover(button);
    const tip = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')),
    );
    expect(tip.textContent).toContain("Move Budget to Trash");
  });

  it("moves the thread to Trash at once, without opening it (ac-2)", async () => {
    const other = fake.addThread("Other");
    const t = fake.addThread("Budget");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    openApp(fake, other);
    const user = userEvent.setup();
    await user.click(await trashButton(await list(), "Budget"));
    await waitFor(() => expect(fake.threads.get(t)?.deleted_at).not.toBeNull());
    expect(confirm).not.toHaveBeenCalled();
    expect(chatRequests(fake, "DELETE").map((r) => r.path)).toEqual([`/v1/threads/${t}`]);
    expect(window.location.search).not.toContain(t);
    expect(chatRequests(fake, "GET").filter((r) => r.path.startsWith(`/v1/threads/${t}`))).toEqual(
      [],
    );
  });

  it("shows a refused move beside the row, as the menu does", async () => {
    const t = fake.addThread("Budget");
    fake.failNext.set(
      `DELETE /v1/threads/${t}`,
      Response.json(
        { code: "thread_busy", message: "Stop the run and clear the queue first." },
        { status: 409 },
      ),
    );
    openApp(fake);
    await userEvent.setup().click(await trashButton(await list(), "Budget"));
    expect(await screen.findByText("“Budget” could not be moved to Trash.")).toBeTruthy();
    expect(fake.threads.get(t)?.deleted_at).toBeNull();
  });

  it("is not on Trash rows nor on threads shared with the member read-only (ac-1)", async () => {
    fake.addThread("Mine");
    const shared = fake.addThread("Theirs");
    Object.assign(must(fake.threads.get(shared)), {
      read_only: true,
      visibility: "team",
      owner_name: "Alice Author",
    });
    const gone = fake.addThread("Old plan");
    must(fake.threads.get(gone)).deleted_at = new Date().toISOString();
    openApp(fake);
    await trashButton(await list(), "Mine");
    const panel = await openThreads();
    await within(panel).findByRole("button", { name: "Actions for Theirs" });
    expect(within(panel).queryByRole("button", { name: "Move Theirs to Trash" })).toBeNull();
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Trash" }));
    const trash = within(await threadGroup("Trash"));
    await trash.findByRole("button", { name: "Restore Old plan" });
    expect(trash.queryByRole("button", { name: /to Trash$/u })).toBeNull();
  });

  it("leaves the row menu's Delete in place", async () => {
    fake.addThread("Budget");
    openApp(fake);
    await list();
    const menu = await openRowMenu("Actions for Budget");
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });
});
