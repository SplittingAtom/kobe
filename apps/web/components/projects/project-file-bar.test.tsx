// @vitest-environment happy-dom
/**
 * The editor's project controls (Workspaces CM8, FP3; KOBE-581, ac-1, ac-2): checked out (name,
 * Changes, Commit… / Update / Discard), editable but not checked out ("Check out to edit"),
 * reader (read-only notice); the commit dialog through `commit_conflict` → Update → Commit.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectFileBar } from "./project-file-bar";
import { WorkspaceProjectsProvider } from "./workspace-projects";
import { routedFetch, TEAM, wireCheckout, wireProject } from "./workspace-testing";

const P = "/v1/projects/p-budget";
const state = (diff: unknown[]) => [200, { ...wireCheckout("budget", 2), diff }] as const;
const DIFF = [
  { change: "modified", path: "plan.md", size_bytes: 20, previous_size_bytes: 10 },
  { change: "added", path: "q4.csv", size_bytes: 5 },
];

function mount(path: string, routes: Parameters<typeof routedFetch>[0]) {
  const { fetchFn, calls } = routedFetch(routes);
  render(
    <WorkspaceProjectsProvider teamId={TEAM} fetchFn={fetchFn}>
      <ProjectFileBar path={path} />
    </WorkspaceProjectsProvider>,
  );
  return calls;
}

afterEach(cleanup);

describe("a file in a checked-out project (CM8)", () => {
  const routes = {
    "GET /v1/projects": [200, { projects: [wireProject("budget")] }] as const,
    "GET /v1/me/checkouts": [200, { checkouts: [wireCheckout("budget", 2)] }] as const,
    [`GET ${P}/checkout`]: state(DIFF),
  };

  it("shows the project, the Changes count, Commit…, Update and Discard", async () => {
    mount("projects/budget/plan.md", routes);
    const bar = await screen.findByRole("region", { name: "Project Budget plan" });
    expect(within(bar).getByText(/editing/)).toBeTruthy();
    expect(await within(bar).findByText("Changes: 2 changes")).toBeTruthy();
    for (const name of ["Commit…", "Update", "Discard"]) {
      expect(within(bar).getByRole("button", { name })).toBeTruthy();
    }
    expect(within(bar).queryByRole("button", { name: "Check out to edit" })).toBeNull();
  });

  it("commit_conflict → Update → Commit again", async () => {
    const calls = mount("projects/budget/plan.md", {
      ...routes,
      [`POST ${P}/commit`]: [
        [409, { code: "commit_conflict", message: "The project moved on.", head_seq: 3 }],
        [200, { status: "committed", seq: 4, commit_id: "c-4" }],
      ],
      [`POST ${P}/checkout/update`]: [200, { base_commit_seq: 3, conflict_paths: [] }],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Commit…" }));
    const dialog = await screen.findByRole("dialog", { name: "Commit to Budget plan" });
    const commit = within(dialog).getByRole("button", { name: "Commit" }) as HTMLButtonElement;
    expect(commit.disabled).toBe(true); // a message first
    const message = within(dialog).getByLabelText("What changed?") as HTMLTextAreaElement;
    expect(message.maxLength).toBe(500);
    await user.type(message, "Q4 numbers");
    await user.click(commit);
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(within(dialog).getByText(/has newer commits than your working copy/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Update" }));
    await within(dialog).findByText("Updated Budget plan to the latest commit.");
    expect(within(dialog).queryByRole("button", { name: "Update" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Commit" }));
    expect(await screen.findByText("Committed #4 to Budget plan.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    const posts = calls.filter((c) => c.method === "POST").map((c) => [c.url, c.body]);
    expect(posts).toEqual([
      [`${P}/commit`, { message: "Q4 numbers" }],
      [`${P}/checkout/update`, {}],
      [`${P}/commit`, { message: "Q4 numbers" }],
    ]);
  });

  it("Update names both-changed files inside the project (workspace paths from the server)", async () => {
    mount("projects/budget/plan.md", {
      ...routes,
      [`POST ${P}/checkout/update`]: [
        200,
        { base_commit_seq: 3, conflict_paths: ["projects/budget/data/q4.csv"] },
      ],
    });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Update" }));
    expect(await screen.findByText(/Both sides changed data\/q4\.csv:/)).toBeTruthy();
  });

  it("says when there is nothing to commit", async () => {
    mount("projects/budget/plan.md", {
      ...routes,
      [`POST ${P}/commit`]: [200, { status: "nothing_to_commit" }],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Commit…" }));
    await user.type(screen.getByLabelText("What changed?"), "x");
    await user.click(screen.getByRole("button", { name: "Commit" }));
    expect(await screen.findByText(/Nothing to commit/)).toBeTruthy();
  });

  it("Discard asks when there are changes, and not when there are none", async () => {
    const calls = mount("projects/budget/plan.md", {
      ...routes,
      [`DELETE ${P}/checkout`]: [204],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    const ask = await screen.findByRole("alertdialog");
    expect(ask.textContent).toMatch(/2 changes not committed will be lost/);
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("discards at once when the working copy has no changes", async () => {
    const calls = mount("projects/budget/plan.md", {
      ...routes,
      [`GET ${P}/checkout`]: state([]),
      [`DELETE ${P}/checkout`]: [204],
    });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("a file in a project that is not checked out (FP3; ac-2)", () => {
  it("an editor sees Check out to edit, and checks out", async () => {
    const calls = mount("projects/budget/plan.md", {
      "GET /v1/projects": [200, { projects: [wireProject("budget")] }],
      "GET /v1/me/checkouts": [
        [200, { checkouts: [] }],
        [200, { checkouts: [wireCheckout("budget")] }],
      ],
      [`POST ${P}/checkout`]: [200, wireCheckout("budget")],
      [`GET ${P}/checkout`]: state([]),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Check out to edit" }));
    // The checkout makes it editable: the bar turns into the working copy's.
    expect(await screen.findByRole("button", { name: "Commit…" })).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url === `${P}/checkout`)).toBe(true);
  });

  it("a reader sees a read-only notice and no edit affordance", async () => {
    mount("projects/budget/plan.md", {
      "GET /v1/projects": [200, { projects: [wireProject("budget", { my_role: "reader" })] }],
      "GET /v1/me/checkouts": [200, { checkouts: [] }],
    });
    expect(await screen.findByText(/You can read this project, not change it/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("nothing for a file outside projects, and no request", async () => {
    const calls = mount("notes/plan.md", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region")).toBeNull();
    expect(calls).toEqual([]);
  });
});
