// @vitest-environment happy-dom
/**
 * Workspaces web (KOBE-581): project roles (PR3, PR5; no visibility since KOBE-587), Open to mount (FP2,
 * ac-2), History with diff, download at a commit and Revert, and Working copies (CM7, CM8).
 */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { answerConfirm, forbidNativeConfirm, renderTeam, stubApi } from "../admin/testing";
import { ProjectDetailPage } from "./project-detail-page";
import { ProjectsPage } from "./projects-page";

const P = "p-1";
const project = (over: Record<string, unknown> = {}) => ({
  id: P,
  team_id: "t-1",
  slug: "budget",
  name: "Budget",
  description: "",
  instructions: "",
  default_agent_id: null,
  my_role: "reader",
  file_count: 1,
  head_commit_id: "c-2",
  live_bytes: 4096,
  history_bytes: null,
  live_objects: 3,
  history_objects: null,
  created_by: "u-bob",
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-02T10:00:00Z",
  archived_at: null,
  ...over,
});
const member = (user_id: string, role: string) => ({
  user_id,
  role,
  added_at: "2026-11-02T10:00:00Z",
});
const ROSTER = {
  members: [
    { user_id: "u-me", name: "Ada", email: "ada@x.io", role: "member", joined_at: "2026-01-01" },
    {
      user_id: "u-bob",
      name: "Bob",
      email: "bob@x.io",
      role: "contributor",
      joined_at: "2026-01-01",
    },
    { user_id: "u-cy", name: "Cy", email: "cy@x.io", role: "member", joined_at: "2026-01-01" },
  ],
};
const commit = (seq: number, over: Record<string, unknown> = {}) => ({
  id: `c-${seq}`,
  project_id: P,
  seq,
  parent_id: seq > 1 ? `c-${seq - 1}` : null,
  author_user_id: "u-bob",
  author_kind: "user",
  thread_id: null,
  run_id: null,
  message: `Change ${seq}`,
  file_count: 2,
  bytes: 2048,
  created_at: "2026-11-02T10:00:00Z",
  ...over,
});
const base = (over: Record<string, unknown> = {}, members = [member("u-bob", "owner")]) => ({
  [`GET /v1/projects/${P}`]: [200, project(over)] as const,
  [`GET /v1/projects/${P}/members`]: [200, { members }] as const,
  [`GET /v1/projects/${P}/files`]: [200, { files: [] }] as const,
  [`GET /v1/threads?project_id=${P}`]: [200, { threads: [], next_cursor: null }] as const,
  "GET /v1/team/members": [200, ROSTER] as const,
  "GET /v1/agents/runnable?limit=200": [200, { agents: [], next_cursor: null }] as const,
});

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("roles (PR3, RV1; ac-1, ac-2)", () => {
  it("a reader sees Open to mount and no edit affordances", async () => {
    stubApi(base());
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "member" });
    const open = await screen.findByRole("link", { name: "Open to mount" });
    expect(open.getAttribute("href")).toBe(`/?project=${P}`);
    expect(screen.getByText(/Not in your files yet/).textContent).toMatch(/projects\/budget/);
    expect(screen.getByText(/You can read this project and start conversations/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add a file" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Add a member" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Transfer ownership" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    // History is readable, without Revert.
    const user = userEvent.setup();
    stubApi({
      ...base(),
      [`GET /v1/projects/${P}/commits`]: [200, { commits: [commit(2)], next_before: null }],
      [`GET /v1/projects/${P}/commits/2`]: [
        200,
        { commit: commit(2), tree: [], diff: [{ change: "added", path: "a.csv", size_bytes: 10 }] },
      ],
    });
    await user.click(screen.getByRole("tab", { name: "History" }));
    await user.click(await screen.findByRole("button", { name: "#2 changes" }));
    await screen.findByRole("rowheader", { name: "a.csv" });
    expect(screen.queryByRole("button", { name: /Revert/ })).toBeNull();
  });

  it("a mounted project says where it is, and opens in a conversation", async () => {
    stubApi({
      ...base({ my_role: "editor" }),
      [`GET /v1/threads?project_id=${P}`]: [
        200,
        {
          threads: [
            {
              thread_id: "th-1",
              title: "Q4",
              status: "idle",
              owner_user_id: "u-me",
              project_id: P,
              agent_id: null,
              agent_version: null,
              shared_to_project: false,
              last_activity_at: "2026-11-02T10:00:00Z",
            },
          ],
          next_cursor: null,
        },
      ],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "member" });
    expect(await screen.findByRole("link", { name: "Open in a conversation" })).toBeTruthy();
    expect(screen.getByText("In your files under projects/budget.")).toBeTruthy();
    expect(screen.queryByText(/You can read this project and start/)).toBeNull();
  });

  it("offers owner and editor only, has no visibility control or Restricted badge, and shows storage", async () => {
    stubApi(base({ my_role: "owner" }, [member("u-me", "owner"), member("u-bob", "editor")]));
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "contributor" });
    expect(await screen.findByText(/Everyone else in the workspace is a reader/)).toBeTruthy();
    const select = screen.getByLabelText("Project role of Bob") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["owner", "editor"]);
    expect(select.value).toBe("editor");
    const add = within(screen.getByRole("form", { name: "Add a member" }));
    const addRole = add.getByLabelText("Role") as HTMLSelectElement;
    expect(addRole.value).toBe("editor");
    expect([...addRole.options].map((o) => o.value)).toEqual(["owner", "editor"]);
    expect(screen.queryByLabelText("Visibility")).toBeNull();
    expect(screen.queryByText(/Restricted/)).toBeNull();
    // Storage: live figures, "—" for those not counted yet.
    expect(screen.getByText("4 KB")).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("re-roles a member to owner on the wire", async () => {
    const calls = stubApi({
      ...base({ my_role: "owner" }, [member("u-me", "owner"), member("u-bob", "editor")]),
      [`PATCH /v1/projects/${P}/members/u-bob`]: [200, member("u-bob", "owner")],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "contributor" });
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Project role of Bob"), "owner");
    await user.click(screen.getByRole("button", { name: "Save role of Bob" }));
    await screen.findByText("Bob is now owner.");
    const patch = must(calls.find((c) => c.method === "PATCH"));
    expect(JSON.parse(String(patch.body))).toEqual({ role: "owner" });
  });

  it("a team admin assigns an owner to an owner-less project", async () => {
    const calls = stubApi({
      ...base({ my_role: null }, [member("u-bob", "editor")]),
      [`POST /v1/projects/${P}/owner`]: [
        200,
        { project_id: P, owner_user_id: "u-cy", previous_owner_user_id: null },
      ],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "team_admin" });
    expect(await screen.findByText(/No owner: assign one below/)).toBeTruthy();
    const form = within(screen.getByRole("form", { name: "Transfer ownership" }));
    const user = userEvent.setup();
    await user.selectOptions(form.getByLabelText("New owner"), "Cy (cy@x.io)");
    await user.click(form.getByRole("button", { name: "Transfer ownership" }));
    await screen.findByText("Cy owns Budget now.");
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({ user_id: "u-cy" });
  });

  it("says No owner, without the assign prompt, to someone who cannot assign", async () => {
    stubApi(base({ my_role: "reader" }, [member("u-bob", "editor")]));
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "member" });
    expect(await screen.findByText(/^No owner\. Team admins manage/)).toBeTruthy();
    expect(screen.queryByText(/assign one below/)).toBeNull();
  });

  it("lists owner-less projects to team admins on the Projects page", async () => {
    stubApi({
      "GET /v1/projects": [200, { projects: [project({ my_role: null })] }],
      "GET /v1/projects/no-owner": [200, { projects: [project({ my_role: null })] }],
      "GET /v1/agents/runnable?limit=200": [200, { agents: [] }],
    });
    renderTeam(<ProjectsPage />, { role: "team_admin" });
    const link = await screen.findByRole("link", { name: "No owner: assign one" });
    expect(link.getAttribute("href")).toBe(`/me/projects/${P}#project-owner`);
    // No Visibility column any more (KOBE-587): every member reads every project.
    expect(screen.queryByText("Whole workspace")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Visibility" })).toBeNull();
  });

  it("never asks a member for the owner-less list", async () => {
    const calls = stubApi({
      "GET /v1/projects": [200, { projects: [project()] }],
      "GET /v1/agents/runnable?limit=200": [200, { agents: [] }],
    });
    renderTeam(<ProjectsPage />, { role: "member" });
    await screen.findByRole("link", { name: "Budget" });
    expect(calls.some((c) => c.url === "/v1/projects/no-owner")).toBe(false);
  });
});

describe("history and working copies (CM7, CM8; ac-1)", () => {
  const history = {
    [`GET /v1/projects/${P}/commits`]: [
      200,
      { commits: [commit(3), commit(2, { author_kind: "agent" })], next_before: 2 },
    ] as const,
    [`GET /v1/projects/${P}/commits?before=2`]: [
      200,
      { commits: [commit(1)], next_before: null },
    ] as const,
    [`GET /v1/projects/${P}/commits/2`]: [
      200,
      {
        commit: commit(2),
        tree: [
          {
            path: "data/a.csv",
            sha256: "a".repeat(64),
            blob_ref: "x",
            size_bytes: 2048,
            mime_type: "text/csv",
            executable: false,
          },
        ],
        diff: [
          { change: "added", path: "data/a.csv", size_bytes: 2048 },
          { change: "modified", path: "b.md", size_bytes: 20, previous_size_bytes: 10 },
          { change: "deleted", path: "old.txt", previous_size_bytes: 5 },
        ],
      },
    ] as const,
    [`GET /v1/projects/${P}/checkouts`]: [
      200,
      {
        checkouts: [
          {
            project_id: P,
            slug: "budget",
            user_id: "u-cy",
            base_commit_id: "c-2",
            base_commit_seq: 2,
            created_at: "2026-11-03T10:00:00Z",
            updated_at: "2026-11-03T10:00:00Z",
          },
        ],
      },
    ] as const,
  };

  it("pages commits, shows a diff, downloads a file at a commit and reverts", async () => {
    const calls = stubApi({
      ...base({ my_role: "editor" }),
      ...history,
      [`GET /v1/projects/${P}/commits/2/files/data/a.csv`]: [200, new Uint8Array([65])],
      [`POST /v1/projects/${P}/commits/2/revert`]: [
        200,
        { status: "committed", seq: 4, commit_id: "c-4" },
      ],
    });
    const created = vi.fn(() => "blob:x");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "member" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "History" }));
    expect(await screen.findByText("Change 3")).toBeTruthy();
    expect(screen.getByText("Agent for Bob")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show older commits" }));
    expect(await screen.findByText("Change 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show older commits" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "#2 changes" }));
    const changes = await screen.findByRole("table", { name: "Changes in this commit" });
    expect(within(changes).getByText("Added")).toBeTruthy();
    expect(within(changes).getByText("10 B → 20 B")).toBeTruthy();
    expect(within(changes).getByText("Deleted")).toBeTruthy();
    // A deleted file has nothing to download.
    expect(within(changes).queryByRole("button", { name: "Download old.txt" })).toBeNull();
    await user.click(within(changes).getByRole("button", { name: "Download data/a.csv" }));
    await screen.findByText("Downloaded data/a.csv as of #2.");
    expect(created).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Revert to #2" }));
    expect(await answerConfirm("Revert Budget to #2?", "Revert")).toMatch(/Nothing in the history/);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/commits/2/revert"))).toBe(
        true,
      ),
    );
    // An editor is not shown the working copies (owners and admins only).
    expect(calls.some((c) => c.url.endsWith("/checkouts"))).toBe(false);
  });

  it("shows owners who has a working copy, since when and from which commit", async () => {
    stubApi({ ...base({ my_role: "owner" }), ...history });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "contributor" });
    await userEvent.setup().click(await screen.findByRole("tab", { name: "History" }));
    const copies = await screen.findByRole("table", { name: "Working copies" });
    expect(within(copies).getByRole("rowheader", { name: "Cy" })).toBeTruthy();
    expect(within(copies).getByText("#2")).toBeTruthy();
  });
});

describe("download the latest files (GV5)", () => {
  it("downloads the head as <slug>.zip, for a reader too", async () => {
    const calls = stubApi({
      ...base(),
      [`GET /v1/projects/${P}/download`]: [200, new Uint8Array([80, 75])],
    });
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }),
    );
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "member" });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Download as zip" }));
    expect(await screen.findByText("Downloaded budget.zip.")).toBeTruthy();
    expect(calls.some((c) => c.url === `/v1/projects/${P}/download`)).toBe(true);
  });
});
