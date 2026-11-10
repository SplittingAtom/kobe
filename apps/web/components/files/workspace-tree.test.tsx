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

function mount(extra: Partial<React.ComponentProps<typeof FileBrowser>> = {}) {
  const { fetchFn, calls } = routedFetch(routes);
  render(
    <div data-kobe-chat>
      <IconActionProvider>
        <WorkspaceProjectsProvider teamId={TEAM} fetchFn={fetchFn}>
          <FileBrowser
            api={createFilesApi(TEAM, fetchFn)}
            workspaceName="Marketing"
            refreshAfterWakeMs={60_000}
            {...extra}
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
    const all = screen.getByRole("link", { name: "Manage projects →" });
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

  it("says when the workspace has no project, and still links to Manage projects", async () => {
    routes["GET /v1/workspace/files"] = listing("", [entry("notes", "dir")]);
    routes["GET /v1/projects"] = [200, { projects: [] }];
    delete routes["GET /v1/workspace/files?path=projects"];
    mount();
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage projects →" })).toBeTruthy();
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

describe("every project, the conversation's one active (KOBE-590, FP1-FP6)", () => {
  const names = () =>
    within(projects())
      .getAllByRole("treeitem")
      .filter((r) => r.getAttribute("aria-level") === "1")
      .map((r) => r.getAttribute("aria-label"));

  it("lists every non-archived project, mounted or not, the active one first with a dot", async () => {
    mount({ activeProjectId: "p-ops" });
    await project("Other plan");
    expect(names()).toEqual(["Ops plan", "Budget plan", "Deck plan", "Other plan"]);
    const ops = await project("Ops plan");
    expect(within(ops).getByRole("img", { name: "Active in this conversation" })).toBeTruthy();
    expect(ops.textContent).not.toMatch(/Not in this conversation/);
    const deck = await project("Deck plan");
    expect(within(deck).queryByRole("img", { name: "Active in this conversation" })).toBeNull();
    expect(deck.querySelector("span.text-muted-foreground")?.textContent).toBe("Deck plan");
    expect(deck.querySelector("[id$='-d']")?.textContent).toMatch(/Not in this conversation/);
    // Role chip and editing stay on a greyed row; editing is never greyed.
    const budget = await project("Budget plan");
    expect(within(budget).getByText("editor")).toBeTruthy();
    expect(within(budget).getByText(/^editing/).className).toContain("text-foreground");
  });

  it("a conversation with no project has no active row", async () => {
    mount({ activeProjectId: null });
    await project("Other plan");
    expect(
      within(projects()).queryByRole("img", { name: "Active in this conversation" }),
    ).toBeNull();
    expect(names()).toEqual(["Budget plan", "Deck plan", "Ops plan", "Other plan"]);
  });

  it("opens an unmounted project from its head, read-only, without mounting it", async () => {
    routes["GET /v1/projects/p-other/files"] = [
      200,
      {
        files: [
          {
            id: "f1",
            project_id: "p-other",
            path: "brief.md",
            size_bytes: 5,
            sha256: "x",
            mime_type: "text/markdown",
            source: "upload",
            added_by: "u-1",
            added_at: "2026-11-01T10:00:00Z",
          },
        ],
      },
    ];
    const calls = mount();
    await userEvent.setup().click(await project("Other plan"));
    expect(await within(projects()).findByRole("treeitem", { name: "brief.md" })).toBeTruthy();
    expect(calls.some((c) => c.method !== "GET" && c.url.includes("mount"))).toBe(false);
    expect(calls.filter((c) => c.method === "POST" && c.url !== "/v1/workspace/wake")).toEqual([]);
  });

  it("refuses to drag an unmounted project's file onto the composer", async () => {
    routes["GET /v1/projects/p-other/files"] = [
      200,
      {
        files: [
          {
            id: "f1",
            project_id: "p-other",
            path: "brief.md",
            size_bytes: 5,
            sha256: "x",
            mime_type: "text/markdown",
            source: "upload",
            added_by: "u-1",
            added_at: "2026-11-01T10:00:00Z",
          },
        ],
      },
    ];
    mount();
    await userEvent.setup().click(await project("Other plan"));
    const file = await within(projects()).findByRole("treeitem", { name: "brief.md" });
    const data: Record<string, string> = {};
    fireEvent.dragStart(file, {
      dataTransfer: {
        setData: (type: string, value: string) => (data[type] = value),
        types: [],
        effectAllowed: "",
      },
    });
    expect(data).toEqual({
      "application/x-kobe-unmounted-project-file":
        "Start a conversation in Other plan to mention its files",
    });
  });

  it("a greyed project's menu starts a conversation, moves this one here, opens the project", async () => {
    const started: string[] = [];
    const moved: string[] = [];
    mount({
      activeProjectId: "p-ops",
      onNewConversationIn: (p) => started.push(p.id),
      onMoveHere: async (p) => {
        moved.push(p.id);
        return undefined;
      },
    });
    const user = userEvent.setup();
    const deck = await project("Deck plan");
    await user.click(within(deck).getByRole("button", { name: "Actions for Deck plan" }));
    const menu = await screen.findByRole("menu", { name: "Actions for Deck plan" });
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(items).toEqual(
      expect.arrayContaining([
        "New conversation in this project",
        "Move this conversation here",
        "Open project page",
      ]),
    );
    await user.click(within(menu).getByRole("menuitem", { name: "Move this conversation here" }));
    await waitFor(() => expect(moved).toEqual(["p-deck"]));
    expect(await screen.findByText("Moved this conversation to Deck plan")).toBeTruthy();
    const other = await project("Other plan");
    await user.click(within(other).getByRole("button", { name: "Actions for Other plan" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "New conversation in this project" }),
    );
    expect(started).toEqual(["p-other"]);
  });

  it("the active project's menu has no move or new conversation; no Move without an own conversation", async () => {
    mount({ activeProjectId: "p-ops", onNewConversationIn: () => undefined });
    const user = userEvent.setup();
    const ops = await project("Ops plan");
    await user.click(within(ops).getByRole("button", { name: "Actions for Ops plan" }));
    const menu = await screen.findByRole("menu", { name: "Actions for Ops plan" });
    expect(within(menu).queryByRole("menuitem", { name: /conversation/ })).toBeNull();
    await user.keyboard("{Escape}");
    const deck = await project("Deck plan");
    await user.click(within(deck).getByRole("button", { name: "Actions for Deck plan" }));
    const other = await screen.findByRole("menu", { name: "Actions for Deck plan" });
    expect(
      within(other).queryByRole("menuitem", { name: "Move this conversation here" }),
    ).toBeNull();
  });

  it("scale: a filter from 20 projects, a cap above 50 with Show all (N)", async () => {
    const many = Array.from({ length: 60 }, (_, i) => {
      const slug = `p${String(i).padStart(2, "0")}`;
      return wireProject(slug, {
        name: `Project ${slug}`,
        updated_at: `2026-11-01T10:${String(i).padStart(2, "0")}:00Z`,
      });
    });
    routes["GET /v1/projects"] = [200, { projects: many }];
    routes["GET /v1/workspace/files?path=projects"] = listing("projects", []);
    routes["GET /v1/me/checkouts"] = [200, { checkouts: [] }];
    mount({ activeProjectId: "p-p00" });
    const user = userEvent.setup();
    await within(projects()).findByRole("treeitem", { name: "Project p59" });
    // The 50 most recent plus the active (oldest) one.
    expect(names()).toHaveLength(51);
    expect(names()[0]).toBe("Project p00");
    const showAll = screen.getByRole("button", { name: "Show all (60)" });
    await user.click(showAll);
    expect(names()).toHaveLength(60);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    await user.type(screen.getByRole("searchbox", { name: "Filter projects" }), "p07");
    expect(names()).toEqual(["Project p07"]);
  });

  it("no filter field below 20 projects", async () => {
    mount();
    await project("Other plan");
    expect(screen.queryByRole("searchbox", { name: "Filter projects" })).toBeNull();
  });
});
