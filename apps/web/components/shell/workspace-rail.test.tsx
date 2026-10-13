// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { openApp } from "../chat/testing";

/** KOBE-198 (CE2, CE5): the workspace rail. */
let fake: FakeKobe;
const PROJECT_A = "00000000-0000-4000-8000-0000000000a1";
const PROJECT_B = "00000000-0000-4000-8000-0000000000b2";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  // The fake chat server, plus the project names the groups ask for.
  const inner = fake.fetch;
  const fetchFn: typeof fetch = async (input, init) => {
    if (new URL(String(input), "http://kobe.test").pathname === "/v1/projects") {
      return Response.json({
        projects: [
          { id: PROJECT_B, name: "Budget 2027" },
          { id: PROJECT_A, name: "Website" },
        ],
      });
    }
    return inner(input, init);
  };
  Object.defineProperty(fake, "fetch", { value: fetchFn });
  vi.stubGlobal("fetch", fetchFn);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rail = () => screen.getByRole("complementary", { name: "Workspace" });
const divider = () => screen.getByRole("separator", { name: "Resize Threads and Files" });
const rows = () =>
  must(document.getElementById("kobe-rail-sections")).style.gridTemplateRows.replace(/\s+/g, " ");

function openWithFetch() {
  window.history.replaceState(null, "", "/");
  return openApp(fake);
}

describe("rail (ac-1)", () => {
  it("is headed by the active team's name, with Threads over Files", async () => {
    openWithFetch();
    expect(
      await within(await screen.findByRole("complementary", { name: "Workspace" })).findByRole(
        "heading",
        { name: "Finance", level: 2 },
      ),
    ).toBeTruthy();
    const sections = within(rail())
      .getAllByRole("region")
      .map((r) => r.getAttribute("id"));
    expect(sections).toEqual(["kobe-rail-threads", "kobe-rail-files"]);
    expect(within(rail()).getByRole("region", { name: "Threads" })).toBeTruthy();
    expect(within(rail()).getByRole("region", { name: "Files" })).toBeTruthy();
  });

  it("collapses to three icons: New keeps it collapsed, threads and files expand it", async () => {
    openWithFetch();
    await screen.findByRole("heading", { name: "Finance" });
    const user = userEvent.setup();
    await user.click(within(rail()).getByRole("button", { name: "Collapse the rail" }));
    expect(rail().hasAttribute("data-collapsed")).toBe(true);
    expect(
      within(rail())
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["New conversation", "Show threads", "Show files"]);
    await user.click(within(rail()).getByRole("button", { name: "New conversation" }));
    expect(rail().hasAttribute("data-collapsed")).toBe(true);
    for (const [icon, focused] of [
      ["Show threads", "kobe-rail-threads"],
      ["Show files", "kobe-rail-files"],
    ] as const) {
      await user.click(within(rail()).getByRole("button", { name: icon }));
      await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(false));
      await waitFor(() => expect(document.activeElement?.id).toBe(focused));
      await user.click(within(rail()).getByRole("button", { name: "Collapse the rail" }));
    }
  });

  it("renders the same expanded markup first on narrow screens, then collapses", async () => {
    const narrow = vi
      .spyOn(window, "matchMedia")
      .mockImplementation(
        (query) => ({ matches: query.includes("max-width"), media: query }) as MediaQueryList,
      );
    openWithFetch();
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    expect(narrow).toHaveBeenCalled();
  });
});

describe("divider (ac-1)", () => {
  it("is a separator at 60% by default, moved with the keyboard and clamped", async () => {
    openWithFetch();
    await screen.findByRole("heading", { name: "Finance" });
    const sep = divider();
    expect(sep.getAttribute("aria-valuenow")).toBe("60");
    expect(sep.getAttribute("aria-controls")).toBe("kobe-rail-threads");
    expect(sep.tabIndex).toBe(0);
    const user = userEvent.setup();
    sep.focus();
    await user.keyboard("{ArrowDown}");
    expect(divider().getAttribute("aria-valuenow")).toBe("65");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(divider().getAttribute("aria-valuenow")).toBe("55");
    expect(rows()).toBe("minmax(0, 0.55fr) auto minmax(0, 0.45fr)");
    await user.keyboard("{Home}");
    expect(divider().getAttribute("aria-valuenow")).toBe("20");
    await user.keyboard("{ArrowUp}");
    expect(divider().getAttribute("aria-valuenow")).toBe("20");
    await user.keyboard("{End}");
    expect(divider().getAttribute("aria-valuenow")).toBe("80");
  });

  it("follows the pointer while dragged, and stops on release", async () => {
    openWithFetch();
    await screen.findByRole("heading", { name: "Finance" });
    const rect = (top: number, height: number) =>
      ({
        top,
        height,
        bottom: top + height,
        left: 0,
        right: 280,
        width: 280,
        x: 0,
        y: top,
      }) as DOMRect;
    // 408 px of sections, 8 of them the divider: 400 px to share between Threads and Files.
    vi.spyOn(
      must(document.getElementById("kobe-rail-sections")),
      "getBoundingClientRect",
    ).mockReturnValue(rect(100, 408));
    const sep = divider();
    vi.spyOn(sep, "getBoundingClientRect").mockReturnValue(rect(0, 8));
    fireEvent.pointerMove(sep, { clientY: 200, pointerId: 1 });
    expect(divider().getAttribute("aria-valuenow")).toBe("60"); // not dragging yet
    fireEvent.pointerDown(sep, { clientY: 344, button: 0, pointerId: 1 });
    // The divider's middle under the pointer: 180 px of Threads above it, 45%.
    fireEvent.pointerMove(sep, { clientY: 284, pointerId: 1 });
    expect(divider().getAttribute("aria-valuenow")).toBe("45");
    expect(rows()).toBe("minmax(0, 0.45fr) auto minmax(0, 0.55fr)");
    fireEvent.pointerMove(sep, { clientY: 110, pointerId: 1 });
    expect(divider().getAttribute("aria-valuenow")).toBe("20"); // clamped
    fireEvent.pointerUp(sep, { clientY: 110, pointerId: 1 });
    // Committed on release: the rail keeps it through a re-render (keyboard from there).
    sep.focus();
    await userEvent.setup().keyboard("{ArrowDown}");
    expect(divider().getAttribute("aria-valuenow")).toBe("25");
    fireEvent.pointerMove(sep, { clientY: 400, pointerId: 1 });
    expect(divider().getAttribute("aria-valuenow")).toBe("25");
  });
});

describe("thread groups (ac-2)", () => {
  it("renders the groups that have threads, in the fixed order", async () => {
    const plain = fake.addThread("Plain chat");
    const site = fake.addThread("Landing page");
    must(fake.threads.get(site)).project_id = PROJECT_A;
    const budget = fake.addThread("Q3 budget");
    must(fake.threads.get(budget)).project_id = PROJECT_B;
    fake.setScheduleId(fake.addThread("Morning digest"), "00000000-0000-4000-8000-0000000005c1");
    const old = fake.addThread("Old idea");
    must(fake.threads.get(old)).deleted_at = "2026-10-01T10:00:00.000Z";
    openWithFetch();
    const threads = within(await screen.findByRole("region", { name: "Threads" }));
    await waitFor(() =>
      expect(threads.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual([
        "Budget 20271",
        "Website1",
        "Your threads1",
        "Scheduled1",
        "Trash1",
      ]),
    );
    expect(threads.queryByRole("button", { name: "Pinned" })).toBeNull();
    expect(threads.queryByRole("button", { name: "Archived" })).toBeNull();
    expect(threads.queryByRole("button", { name: "Shared with me" })).toBeNull();
    const list = (name: string) => within(threads.getByRole("list", { name }));
    expect(list("Website").getByRole("button", { name: "Landing page" })).toBeTruthy();
    expect(list("Budget 2027").getByRole("button", { name: "Q3 budget" })).toBeTruthy();
    expect(list("Your threads").getByRole("button", { name: "Plain chat" })).toBeTruthy();
    expect(list("Scheduled").getByRole("button", { name: "Morning digest" })).toBeTruthy();
    expect(plain).toBeTruthy();

    // Trash starts collapsed; its toggle opens it.
    const trash = threads.getByRole("button", { name: "Trash" });
    expect(trash.getAttribute("aria-expanded")).toBe("false");
    await userEvent.setup().click(trash);
    expect(list("Trash").getByRole("button", { name: "Restore Old idea" })).toBeTruthy();
  });

  it("folds a group on its toggle", async () => {
    fake.addThread("Plain chat");
    openWithFetch();
    const toggle = await screen.findByRole("button", { name: "Your threads" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.setup().click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Plain chat" })).toBeNull();
  });

  it("puts a thread created in a project in that project's group before the list is read again", async () => {
    let lists = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const inner = fake.fetch;
    Object.defineProperty(fake, "fetch", {
      value: async (input: string, init?: RequestInit) => {
        const url = new URL(input, "http://kobe.test");
        if (url.pathname === "/v1/threads" && (init?.method ?? "GET") === "GET" && ++lists > 1) {
          await held; // the reload after the first message waits
        }
        return inner(input, init);
      },
    });
    openApp(fake, undefined, undefined, `?project=${PROJECT_A}`);
    await screen.findByText("No threads yet.");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Message"), "Hero copy{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    const website = await screen.findByRole("list", { name: "Website" });
    expect(within(website).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("list", { name: "Your threads" })).toBeNull();
    release();
  });
});

describe("project names", () => {
  it("says when they could not be read, and reads them again on focus", async () => {
    const t = fake.addThread("Landing page");
    must(fake.threads.get(t)).project_id = PROJECT_A;
    let answer: () => Response = () =>
      Response.json({ code: "unavailable", message: "down" }, { status: 503 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inner = fake.fetch;
    Object.defineProperty(fake, "fetch", {
      value: async (input: string, init?: RequestInit) =>
        new URL(input, "http://kobe.test").pathname === "/v1/projects"
          ? answer()
          : inner(input, init),
    });
    openWithFetch();
    expect(await screen.findByText("Project names could not be loaded.")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Project" })).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    answer = () => Response.json({ projects: [{ id: PROJECT_A, name: "Site redesign" }] });
    fireEvent.focus(window);
    expect(await screen.findByRole("list", { name: "Site redesign" })).toBeTruthy();
    expect(screen.queryByText("Project names could not be loaded.")).toBeNull();
  });
});
