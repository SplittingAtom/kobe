// @vitest-environment happy-dom
/**
 * The Files panel as the Workspace (Workspaces FP1; KOBE-581, ac-1, ac-3): Workspace: <name>,
 * Projects (mounted projects by name, slug as hover text, role chip, editing mark, All projects
 * link, the project menu) and My files (no projects/ folder, never called "workspace"); drops on
 * a read-only project are explained, a checked-out project takes them.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFilesApi } from "../../lib/files/api";
import { IconActionProvider } from "../shell/icon-action";
import { WorkspaceProjectsProvider } from "../projects/workspace-projects";
import { routedFetch, TEAM, wireCheckout, wireProject } from "../projects/workspace-testing";
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
    "GET /v1/workspace/files": listing("", [
      entry("notes", "dir"),
      entry("projects", "dir"),
      entry("uploads", "dir"),
    ]),
    "GET /v1/workspace/files?path=projects": listing("projects", [
      entry("projects/budget", "dir"),
      entry("projects/deck", "dir"),
      entry("projects/ops", "dir"),
    ]),
    "GET /v1/projects": [
      200,
      {
        projects: [
          wireProject("budget"),
          wireProject("deck", { my_role: "reader" }),
          wireProject("ops", { my_role: null }),
          wireProject("old", { archived_at: "2026-11-02T00:00:00Z" }),
          wireProject("other"),
        ],
      },
    ],
    "GET /v1/me/checkouts": [200, { checkouts: [wireCheckout("budget")] }],
  };
});
afterEach(cleanup);

function mount() {
  const { fetchFn, calls } = routedFetch(routes);
  render(
    <div data-kobe-chat>
      <IconActionProvider>
        <WorkspaceProjectsProvider teamId={TEAM} fetchFn={fetchFn}>
          <FileBrowser
            api={createFilesApi(TEAM, fetchFn)}
            workspaceName="Marketing"
            refreshAfterWakeMs={60_000}
          />
        </WorkspaceProjectsProvider>
      </IconActionProvider>
    </div>,
  );
  return calls;
}

const projects = () => screen.getByRole("tree", { name: "Projects" });
const project = (name: string) => within(projects()).findByRole("treeitem", { name });
const files = (dt: { files: File[] }) => ({
  ...dt,
  types: ["Files"],
  items: dt.files.map((f) => ({ kind: "file", getAsFile: () => f, webkitGetAsEntry: () => null })),
  dropEffect: "none",
  effectAllowed: "all",
  getData: () => "",
  setData: () => undefined,
});

describe("the Workspace tree (FP1)", () => {
  it("shows the workspace, its mounted projects with roles and the editing mark, and My files", async () => {
    mount();
    expect(screen.getByRole("heading", { name: "Workspace: Marketing" })).toBeTruthy();
    const budget = await project("Budget plan");
    expect(budget.getAttribute("title")).toBe("budget");
    expect(within(budget).getByText("editor")).toBeTruthy();
    expect(budget.textContent).toMatch(/editing ●/);
    // Checked out: writable inside, so no lock.
    expect(budget.querySelector("svg.lucide-folder-lock")).toBeNull();
    const deck = await project("Deck plan");
    expect(within(deck).getByText("reader")).toBeTruthy();
    expect(deck.textContent).not.toMatch(/editing ●/);
    expect(deck.querySelector("svg.lucide-folder-lock")).not.toBeNull();
    // A team admin who is not listed acts as owner.
    expect(within(await project("Ops plan")).getByText("owner")).toBeTruthy();
    // Every readable, live project counts; archived ones do not.
    const all = screen.getByRole("link", { name: "All projects (4) →" });
    expect(all.getAttribute("href")).toBe("/me/projects");
    const mine = screen.getByRole("tree", { name: "My files" });
    expect(
      within(mine)
        .getAllByRole("treeitem")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["notes", "uploads"]);
  });

  it("never calls the member's files the workspace (ac-3)", async () => {
    mount();
    await project("Budget plan");
    expect(screen.getByText("My files")).toBeTruthy();
    // "Workspace" names only the place: the top row.
    const workspaceWords = screen.getAllByText(/workspace/i).map((el) => el.textContent);
    expect(workspaceWords).toEqual(["Workspace: Marketing"]);
  });

  it("explains a drop on a read-only project by role, and uploads into a checked-out one", async () => {
    routes["POST /v1/workspace/files"] = [201, entry("projects/budget/q4.csv", "file")];
    routes["GET /v1/workspace/files?path=projects%2Fbudget"] = listing("projects/budget", [
      entry("projects/budget/q4.csv", "file"),
    ]);
    routes["GET /v1/me/checkouts"] = [200, { checkouts: [wireCheckout("budget")] }];
    routes["GET /v1/projects"] = [
      200,
      {
        projects: [
          wireProject("budget"),
          wireProject("deck", { my_role: "reader" }),
          wireProject("ops"),
        ],
      },
    ];
    const calls = mount();
    const csv = new File(["a,b"], "q4.csv", { type: "text/csv" });
    const deck = await project("Deck plan");
    fireEvent.dragOver(deck, { dataTransfer: files({ files: [csv] }) });
    fireEvent.drop(deck, { dataTransfer: files({ files: [csv] }) });
    expect(screen.getByText("You can read this project, not change it.")).toBeTruthy();
    const ops = await project("Ops plan");
    fireEvent.drop(ops, { dataTransfer: files({ files: [csv] }) });
    expect(screen.getByText("Check out to edit: Ops plan is read-only.")).toBeTruthy();
    const uploads = () =>
      calls.filter((c) => c.method === "POST" && c.url === "/v1/workspace/files");
    expect(uploads()).toHaveLength(0);
    const budget = await project("Budget plan");
    fireEvent.dragOver(budget, { dataTransfer: files({ files: [csv] }) });
    fireEvent.drop(budget, { dataTransfer: files({ files: [csv] }) });
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/v1/workspace/files")).toBe(true),
    );
  });

  it("the project menu offers Commit…, Update and Discard while checked out", async () => {
    routes["POST /v1/projects/p-budget/commit"] = [
      200,
      { status: "committed", seq: 2, commit_id: "c-2" },
    ];
    const calls = mount();
    const budget = await project("Budget plan");
    const user = userEvent.setup();
    await user.click(within(budget).getByRole("button", { name: "Actions for Budget plan" }));
    const menu = await screen.findByRole("menu", { name: "Actions for Budget plan" });
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(items).toEqual(
      expect.arrayContaining(["Commit…", "Update", "Discard", "Open project page"]),
    );
    expect(items).not.toContain("Check out to edit");
    await user.click(within(menu).getByRole("menuitem", { name: "Commit…" }));
    const dialog = await screen.findByRole("dialog", { name: "Commit to Budget plan" });
    await user.type(within(dialog).getByLabelText("What changed?"), "Numbers");
    await user.click(within(dialog).getByRole("button", { name: "Commit" }));
    expect(await screen.findByText("Committed #2 to Budget plan.")).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith("/commit"))?.body).toEqual({ message: "Numbers" });
  });

  it("offers Check out to edit to an editor, and nothing to change to a reader", async () => {
    routes["GET /v1/me/checkouts"] = [200, { checkouts: [] }];
    mount();
    const user = userEvent.setup();
    const budget = await project("Budget plan");
    await user.click(within(budget).getByRole("button", { name: "Actions for Budget plan" }));
    let menu = await screen.findByRole("menu", { name: "Actions for Budget plan" });
    expect(within(menu).getByRole("menuitem", { name: "Check out to edit" })).toBeTruthy();
    await user.keyboard("{Escape}");
    const deck = await project("Deck plan");
    await user.click(within(deck).getByRole("button", { name: "Actions for Deck plan" }));
    menu = await screen.findByRole("menu", { name: "Actions for Deck plan" });
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    for (const edit of ["Check out to edit", "Commit…", "Update", "Discard", "Rename", "Delete"]) {
      expect(items).not.toContain(edit);
    }
  });

  it("says when no project is mounted, and still links to all projects", async () => {
    routes["GET /v1/workspace/files"] = listing("", [entry("notes", "dir")]);
    mount();
    expect(await screen.findByText(/No projects in your files yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /^All projects/ })).toBeTruthy();
  });

  it("a checked-out project's own row keeps Upload and is not called read-only", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await project("Budget plan"));
    expect(await screen.findByLabelText("Upload a file to projects/budget")).toBeTruthy();
    expect(screen.queryByText(/read-only here/)).toBeNull();
    await user.click(await project("Deck plan"));
    expect(await screen.findByText(/This project is read-only here/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Upload a file to/)).toBeNull();
  });

  it("an unreadable checkout list is an error with Try again, never 'no checkouts'", async () => {
    routes["GET /v1/me/checkouts"] = [
      [500, { code: "server_error", message: "x" }],
      [200, { checkouts: [wireCheckout("budget")] }],
    ];
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be read/);
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    const budget = await project("Budget plan");
    await waitFor(() => expect(budget.textContent).toMatch(/editing ●/));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
