// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { composer, openApp } from "../chat/testing";

/**
 * KOBE-612 (spec thread-file-map, TFM1–TFM7): the Threads panel's three rails at wide widths
 * (folders | threads | workspace), lines between thread rows and the files they used on hover,
 * focus and pin, closed-folder aggregation, and the lists ("Files (N)", "Used in") that give the
 * keyboard, screen readers and narrow widths the same links.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };
const enc = (s: string) => new TextEncoder().encode(s);

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

async function openPanel() {
  openApp(fake);
  await composer();
  const user = userEvent.setup();
  await user.click(within(rail()).getByRole("button", { name: "Threads panel" }));
  const dialog = await screen.findByRole("dialog", { name: "Threads" }, WAIT);
  return { user, dialog };
}

/** Budget wrote report.md and read notes/deep/plan.md; Hiring read report.md. */
function seed() {
  fake.workspaceFiles.set("report.md", enc("# Report\n"));
  fake.workspaceFiles.set("notes/deep/plan.md", enc("# Plan\n"));
  fake.workspaceDirs.add("notes");
  fake.workspaceDirs.add("notes/deep");
  const budget = fake.addThread("Budget");
  const hiring = fake.addThread("Hiring");
  fake.fileLinks.link(
    budget,
    { path: "report.md", access: "write" },
    { path: "notes/deep/plan.md", access: "read" },
    { path: "old.md", access: "write", deleted: true },
  );
  fake.fileLinks.hidden.set(budget, 1);
  fake.fileLinks.link(hiring, { path: "report.md", access: "read" });
  return { budget, hiring };
}

const body = (dialog: HTMLElement) => must(dialog.querySelector("[data-kobe-threads-body]"));
const row = (dialog: HTMLElement, id: string) =>
  must(dialog.querySelector<HTMLElement>(`[data-kobe-thread="${id}"]`));
const lines = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll<SVGGElement>("[data-kobe-line]")].map((g) => ({
    anchor: g.getAttribute("data-kobe-line"),
    access: g.getAttribute("data-access"),
  }));

describe("three rails (ac-1)", () => {
  it("shows folders | threads | the workspace, reading the rows' links in one batch", async () => {
    const { budget, hiring } = seed();
    const { dialog } = await openPanel();
    expect(body(dialog).getAttribute("data-kobe-threads-body")).toBe("three-rails");
    const files = await within(dialog).findByRole("tree", { name: "Workspace files" }, WAIT);
    expect(await within(files).findByRole("treeitem", { name: "report.md" }, WAIT)).toBeTruthy();
    await waitFor(() => expect(fake.fileLinks.linkReads.length).toBeGreaterThan(0), WAIT);
    expect(new Set(fake.fileLinks.linkReads.flat())).toEqual(new Set([budget, hiring]));
    // The visible files' threads are read too, in one batch, before any hover.
    await waitFor(() => expect(fake.fileLinks.fileReads.flat()).toContain("report.md"), WAIT);
    // Read-only (TFM6): rows do not drag.
    const report = within(files).getByRole("treeitem", { name: "report.md" });
    expect(report.getAttribute("draggable")).toBe("false");
  });

  it("hovering a thread draws solid lines to written files, dashed to read ones; a closed folder stands for its files", async () => {
    const { budget } = seed();
    const { dialog } = await openPanel();
    await within(dialog).findByRole("treeitem", { name: "report.md" }, WAIT);
    await within(dialog).findByRole("button", { name: "Files (4)" }, WAIT);
    fireEvent.pointerOver(row(dialog, budget));
    await waitFor(() => expect(lines(dialog)).toHaveLength(2), WAIT);
    expect(lines(dialog)).toEqual(
      expect.arrayContaining([
        { anchor: "report.md", access: "write" },
        { anchor: "notes", access: "read" },
      ]),
    );
    const dashed = dialog.querySelector('[data-access="read"] path');
    expect(dashed?.getAttribute("stroke-dasharray")).toBe("4 3");
    expect(
      dialog.querySelector('[data-access="write"] path')?.getAttribute("stroke-dasharray"),
    ).toBeNull();
    // notes/ is closed: the line ends on it, with a count.
    expect(dialog.querySelector('[data-kobe-line-count="notes"]')?.textContent).toBe("1");
    // Decorative: the overlay is hidden from screen readers.
    expect(dialog.querySelector("[data-kobe-file-lines]")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    fireEvent.pointerLeave(body(dialog));
    await waitFor(() => expect(lines(dialog)).toHaveLength(0), WAIT);
  });

  it("keyboard focus on a thread shows its lines too", async () => {
    const { budget } = seed();
    const { dialog } = await openPanel();
    await within(dialog).findByRole("button", { name: "Files (4)" }, WAIT);
    await within(dialog).findByRole("treeitem", { name: "report.md" }, WAIT);
    act(() => within(row(dialog, budget)).getByRole("button", { name: "Budget" }).focus());
    await waitFor(() => expect(lines(dialog)).toHaveLength(2), WAIT);
  });

  it("hovering a file draws lines to the threads that used it, and names off-list ones", async () => {
    const { budget, hiring } = seed();
    const archived = fake.addThread("Old work");
    must(fake.threads.get(archived)).archived_at = "2026-11-09T10:00:00.000Z";
    fake.fileLinks.link(archived, { path: "report.md", access: "read" });
    const { dialog } = await openPanel();
    const report = await within(dialog).findByRole("treeitem", { name: "report.md" }, WAIT);
    await within(dialog).findByRole("button", { name: "Files (4)" }, WAIT);
    fireEvent.pointerOver(report);
    await waitFor(
      () =>
        expect(
          lines(dialog)
            .map((l) => l.anchor)
            .sort(),
        ).toEqual([budget, hiring].sort()),
      WAIT,
    );
    expect(lines(dialog).find((l) => l.anchor === budget)?.access).toBe("write");
    // Old work's row is not in Current's list (archived, or not read by the list): named as elsewhere.
    await waitFor(
      () =>
        expect(dialog.querySelector("[data-kobe-elsewhere]")?.textContent).toMatch(
          /Also used in threads not shown: 1 (in Archived|elsewhere)/,
        ),
      WAIT,
    );
  });

  it("a pinned row keeps its lines after the pointer leaves (TFM5)", async () => {
    seed();
    const { user, dialog } = await openPanel();
    await within(dialog).findByRole("treeitem", { name: "report.md" }, WAIT);
    const pin = await within(dialog).findByRole(
      "button",
      { name: "Keep lines shown for Budget" },
      WAIT,
    );
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    await user.click(pin);
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerLeave(body(dialog));
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await waitFor(() => expect(lines(dialog)).toHaveLength(2), WAIT);
    await user.click(pin);
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    // Unpinned: once neither hovered nor focused, its lines go.
    fireEvent.pointerLeave(body(dialog));
    act(() => within(dialog).getByLabelText("Search threads").focus());
    await waitFor(() => expect(lines(dialog)).toHaveLength(0), WAIT);
  });

  it("a file's menu lists the threads that used it; choosing one opens it and closes the panel", async () => {
    const { hiring } = seed();
    const { user, dialog } = await openPanel();
    await within(dialog).findByRole("treeitem", { name: "report.md" }, WAIT);
    await within(dialog).findByRole("button", { name: "Files (4)" }, WAIT);
    await waitFor(() => expect(fake.fileLinks.fileReads.flat()).toContain("report.md"), WAIT);
    await user.click(within(dialog).getByRole("button", { name: "Actions for report.md" }));
    const menu = await screen.findByRole("menu", { name: "Actions for report.md" }, WAIT);
    const trigger = within(menu).getByRole("menuitem", { name: /Used in \(2 threads\)/ });
    trigger.focus();
    await user.keyboard("{ArrowRight}");
    const sub = await screen.findByRole("menu", { name: /Used in/ }, WAIT);
    expect(
      within(sub)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(expect.arrayContaining(["Budget", "Hiring"]));
    within(sub).getByRole("menuitem", { name: "Hiring" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(
      () => expect(document.querySelector('[data-kobe-panel="threads"]')).toBeNull(),
      WAIT,
    );
    expect(window.location.search).toBe(`?thread=${hiring}`);
  });

  it("clicking a file in the rail opens it in the artifact column and closes the panel", async () => {
    seed();
    const { user, dialog } = await openPanel();
    await user.click(await within(dialog).findByRole("treeitem", { name: "report.md" }, WAIT));
    await waitFor(
      () => expect(document.querySelector('[data-kobe-panel="threads"]')).toBeNull(),
      WAIT,
    );
    expect(await screen.findByRole("toolbar", { name: "report.md view" }, WAIT)).toBeTruthy();
  });
});

describe("the lists (ac-2)", () => {
  it("Files (N) lists a thread's files as links, deleted and unseen ones named", async () => {
    seed();
    const { user, dialog } = await openPanel();
    const toggle = await within(dialog).findByRole("button", { name: "Files (4)" }, WAIT);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = within(dialog).getByRole("list", { name: "Files Budget used" });
    expect(must(toggle.getAttribute("aria-controls"))).toBe(list.id);
    const items = within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items).toEqual([
      "report.mdwritten",
      "plan.mdread",
      "old.md (deleted)written",
      "1 file you can't see",
    ]);
    await user.click(within(list).getByRole("button", { name: "report.md" }));
    await waitFor(
      () => expect(document.querySelector('[data-kobe-panel="threads"]')).toBeNull(),
      WAIT,
    );
    expect(await screen.findByRole("toolbar", { name: "report.md view" }, WAIT)).toBeTruthy();
  });

  it("narrower than the wide band: two rails, no workspace rail, no lines, no pin; the lists stay", async () => {
    const { budget } = seed();
    const { dialog } = await openPanel();
    resizeWindow(1000);
    await waitFor(
      () => expect(body(dialog).getAttribute("data-kobe-threads-body")).toBe("two-rails"),
      WAIT,
    );
    expect(await within(dialog).findByRole("button", { name: "Files (4)" }, WAIT)).toBeTruthy();
    expect(within(dialog).queryByRole("tree", { name: "Workspace files" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Keep lines shown/ })).toBeNull();
    fireEvent.pointerOver(row(dialog, budget));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(dialog.querySelector("[data-kobe-file-lines]")).toBeNull();
    // No workspace rail, so its files' threads are not read again.
    const reads = fake.fileLinks.fileReads.length;
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(fake.fileLinks.fileReads.length).toBe(reads);
  });

  it("a thread without links shows no Files row", async () => {
    fake.addThread("Quiet");
    const { dialog } = await openPanel();
    await within(dialog).findByRole("button", { name: "Quiet" }, WAIT);
    await waitFor(() => expect(fake.fileLinks.linkReads.length).toBeGreaterThan(0), WAIT);
    expect(within(dialog).queryByRole("button", { name: /^Files \(/ })).toBeNull();
  });
});
