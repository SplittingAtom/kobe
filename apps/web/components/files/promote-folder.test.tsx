// @vitest-environment happy-dom
/**
 * KOBE-586 (PF1, PF6) in the Files panel: Promote to project… on a My files folder's ⋯ menu for
 * those who create projects (never for members, uploads/ or a project's folder); after it the
 * tree lists again, the new project shows under Projects and the conversation is offered it.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFilesApi } from "../../lib/files/api";
import { IconActionProvider } from "../shell/icon-action";
import { WorkspaceProjectsProvider } from "../projects/workspace-projects";
import { routedFetch, TEAM, wireProject } from "../projects/workspace-testing";
import { FileBrowser } from "./file-browser";

const entry = (path: string, type: "file" | "dir") => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  type,
  size_bytes: type === "dir" ? null : 10,
  mtime: "2026-11-01T10:00:00Z",
  source: "synced",
  area: path.startsWith("projects")
    ? "projects"
    : path.startsWith("uploads")
      ? "uploads"
      : "workspace",
});
const listing = (path: string, entries: ReturnType<typeof entry>[]) =>
  [200, { path, entries }] as const;

let routes: Parameters<typeof routedFetch>[0];

beforeEach(() => {
  routes = {
    "POST /v1/workspace/wake": [202, { status: "waking" }],
    "GET /v1/workspace/files": [
      listing("", [entry("notes", "dir"), entry("projects", "dir"), entry("uploads", "dir")]),
      listing("", [entry("projects", "dir"), entry("uploads", "dir")]),
    ],
    "GET /v1/workspace/files?path=projects": [
      listing("projects", [entry("projects/budget", "dir")]),
      listing("projects", [entry("projects/budget", "dir"), entry("projects/notes", "dir")]),
    ],
    "GET /v1/projects": [
      [200, { projects: [wireProject("budget")] }],
      [200, { projects: [wireProject("budget"), wireProject("notes", { my_role: "owner" })] }],
    ],
    "GET /v1/me/checkouts": [200, { checkouts: [] }],
  };
});
afterEach(cleanup);

function mount(extra: Partial<React.ComponentProps<typeof FileBrowser>> = {}) {
  const { fetchFn, calls } = routedFetch(routes);
  render(
    <div data-kobe-chat>
      <IconActionProvider>
        <WorkspaceProjectsProvider teamId={TEAM} fetchFn={fetchFn}>
          <FileBrowser api={createFilesApi(TEAM, fetchFn)} refreshAfterWakeMs={60_000} {...extra} />
        </WorkspaceProjectsProvider>
      </IconActionProvider>
    </div>,
  );
  return calls;
}

const mine = () => screen.getByRole("tree", { name: "My files" });

async function menuOf(name: string, tree: () => HTMLElement = mine) {
  const row = await within(tree()).findByRole("treeitem", { name });
  const user = userEvent.setup();
  await user.click(within(row).getByRole("button", { name: `Actions for ${name}` }));
  const menu = await screen.findByRole("menu", { name: `Actions for ${name}` });
  const items = within(menu)
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
  return { user, menu, items };
}

describe("Promote to project… in the Files panel (PF1)", () => {
  it("is on a My files folder for those who create projects, not on uploads or projects", async () => {
    mount({ canCreateProjects: true });
    let { user, items } = await menuOf("notes");
    expect(items).toContain("Promote to project…");
    await user.keyboard("{Escape}");
    ({ user, items } = await menuOf("uploads"));
    expect(items).not.toContain("Promote to project…");
    await user.keyboard("{Escape}");
    ({ items } = await menuOf("Budget plan", () => screen.getByRole("tree", { name: "Projects" })));
    expect(items).not.toContain("Promote to project…");
  });

  it("is hidden for members", async () => {
    mount({ canCreateProjects: false });
    const { items } = await menuOf("notes");
    expect(items).not.toContain("Promote to project…");
  });

  it("promotes, lists again, shows the project under Projects and offers it (PF6)", async () => {
    routes["POST /v1/projects/from-folder"] = [
      201,
      wireProject("notes", { id: "p-notes", name: "Notes", my_role: "owner" }),
    ];
    const onPromoted = vi.fn();
    const calls = mount({ canCreateProjects: true, onPromoted });
    const { user, menu } = await menuOf("notes");
    await user.click(within(menu).getByRole("menuitem", { name: "Promote to project…" }));
    const dialog = await screen.findByRole("dialog", { name: "Promote notes to a project" });
    expect(
      (within(dialog).getByRole("textbox", { name: "Project name" }) as HTMLInputElement).value,
    ).toBe("notes");
    await user.click(within(dialog).getByRole("button", { name: "Promote" }));
    await waitFor(() => expect(onPromoted).toHaveBeenCalledWith({ id: "p-notes", name: "Notes" }));
    expect(calls.find((c) => c.url === "/v1/projects/from-folder")?.body).toEqual({
      path: "notes",
      name: "notes",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    const projects = screen.getByRole("tree", { name: "Projects" });
    expect(await within(projects).findByRole("treeitem", { name: "Notes plan" })).toBeTruthy();
    await waitFor(() =>
      expect(within(mine()).queryByRole("treeitem", { name: "notes" })).toBeNull(),
    );
  });

  it("keeps the dialog open with the server's message on a refusal", async () => {
    routes["POST /v1/projects/from-folder"] = [
      507,
      {
        code: "quota_exceeded",
        message: "The project would pass your workspace's storage quota.",
        limit: "bytes",
      },
    ];
    const onPromoted = vi.fn();
    mount({ canCreateProjects: true, onPromoted });
    const { user, menu } = await menuOf("notes");
    await user.click(within(menu).getByRole("menuitem", { name: "Promote to project…" }));
    const dialog = await screen.findByRole("dialog", { name: "Promote notes to a project" });
    await user.click(within(dialog).getByRole("button", { name: "Promote" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("storage quota");
    expect(onPromoted).not.toHaveBeenCalled();
    expect(within(mine()).getByRole("treeitem", { name: "notes" })).toBeTruthy();
  });
});
