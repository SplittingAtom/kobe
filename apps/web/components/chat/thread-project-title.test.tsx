// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, openApp } from "./testing";

/** KOBE-589 (PC-2): "<Project> / <conversation name>" with a project menu (spec §4 TT1-TT4). */
let fake: FakeKobe;
let alpha: string;
let beta: string;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  document.title = "Kobe";
  fake = new FakeKobe();
  alpha = fake.addProject("Alpha");
  beta = fake.addProject("Beta");
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function inProject(title: string | null, project: string | null = alpha): string {
  const t = fake.addThread(title);
  must(fake.threads.get(t)).project_id = project;
  return t;
}
const heading = (name: string) => screen.findByRole("heading", { level: 2, name });
const projectButton = (name = "Project Alpha") => screen.findByRole("button", { name });
/** The menu reads the projects when it opens: an item is ready once its reason is gone. */
const ready = async (item: HTMLElement) =>
  waitFor(() => expect(item.getAttribute("aria-disabled")).toBeNull());
const moves = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/move"));

describe("title format (TT1)", () => {
  it("reads <Project> / <name>, project muted, rename button unchanged", async () => {
    openApp(fake, inProject("Budget"));
    const h = await heading("Alpha / Budget");
    expect(within(h).getByText("Alpha").className).toContain("text-muted-foreground");
    expect(await screen.findByRole("button", { name: "Rename Budget" })).toBeTruthy();
  });

  it("falls back to Untitled conversation, and a conversation without a project is unchanged", async () => {
    openApp(fake, inProject(null));
    expect(await heading("Alpha / Untitled conversation")).toBeTruthy();
    cleanup();
    openApp(fake, inProject("Plain", null));
    expect(await heading("Plain")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Project / })).toBeNull();
  });

  it("the tab title follows it (TT4) and is restored when the thread closes", async () => {
    const view = openApp(fake, inProject("Budget"));
    await heading("Alpha / Budget");
    await waitFor(() => expect(document.title).toBe("Alpha / Budget"));
    view.unmount();
    expect(document.title).toBe("Kobe");
  });

  it("the tab title is the bare name without a project", async () => {
    openApp(fake, inProject("Plain", null));
    await waitFor(() => expect(document.title).toBe("Plain"));
  });
});

describe("project part (TT2)", () => {
  it("shrinks first (max 40%) and has full-name tooltips on both parts", async () => {
    openApp(fake, inProject("Budget"));
    const project = await projectButton();
    expect(project.className).toContain("max-w-[40%]");
    expect(project.getAttribute("title")).toBe("Alpha");
    expect(screen.getByRole("button", { name: "Rename Budget" }).getAttribute("title")).toContain(
      "Budget",
    );
  });

  it("Open project links to the project page", async () => {
    openApp(fake, inProject("Budget"));
    await userEvent.setup().click(await projectButton());
    const link = await screen.findByRole("menuitem", { name: "Open project" });
    expect(link.closest("a")?.getAttribute("href")).toBe(`/me/projects/${alpha}`);
  });

  it("Move out of the project uses the move route and the title drops the project", async () => {
    const t = inProject("Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(await projectButton());
    const out = await screen.findByRole("menuitem", { name: "Move out of the project" });
    await ready(out);
    await user.click(out);
    await waitFor(() => expect(fake.threads.get(t)?.project_id).toBeNull());
    expect(moves().at(-1)).toMatchObject({
      path: `/v1/threads/${t}/move`,
      body: { project_id: null },
    });
    expect(await heading("Budget")).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Budget"));
  });

  it("Move to project… lists the other projects and moves there", async () => {
    const t = inProject("Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(await projectButton());
    const sub = await screen.findByRole("menuitem", { name: "Move to project…" });
    await ready(sub);
    // Keyboard: happy-dom has no layout for Radix's pointer grace area between the menus.
    sub.focus();
    await user.keyboard("{ArrowRight}");
    (await screen.findByRole("menuitem", { name: "Beta" })).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.project_id).toBe(beta));
    expect(await heading("Beta / Budget")).toBeTruthy();
  });

  it("works from the keyboard: Enter opens, arrows move, Enter chooses, focus returns", async () => {
    const t = inProject("Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    (await projectButton()).focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Open project", "Move to project…", "Move out of the project"]);
    await ready(within(menu).getByRole("menuitem", { name: "Move out of the project" }));
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.project_id).toBeNull());
    await user.keyboard("{Escape}");
  });

  it("says why a move is refused and keeps the project", async () => {
    const t = inProject("Budget");
    openApp(fake, t);
    fake.refuseOrganize = { status: 409, code: "thread_busy", message: "The thread is busy." };
    const user = userEvent.setup();
    await user.click(await projectButton());
    const out = await screen.findByRole("menuitem", { name: "Move out of the project" });
    await ready(out);
    await user.click(out);
    expect((await screen.findByRole("alert")).textContent).toContain("busy");
    expect(fake.threads.get(t)?.project_id).toBe(alpha);
  });
});

describe("no menus (TT3)", () => {
  it("a shared reader sees the title without menus", async () => {
    const t = inProject("Budget");
    must(fake.threads.get(t)).read_only = true;
    openApp(fake, t);
    expect(await heading("Alpha / Budget")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Project / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename Budget" })).toBeNull();
  });

  it("a conversation in Trash sees the title without menus", async () => {
    const t = inProject("Budget");
    must(fake.threads.get(t)).deleted_at = "2026-10-02T09:00:00.000Z";
    openApp(fake, t);
    expect(await heading("Alpha / Budget")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Project / })).toBeNull();
  });
});
