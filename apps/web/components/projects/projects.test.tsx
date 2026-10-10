// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { renderTeam, stubApi } from "../admin/testing";
import { ProjectDetailPage } from "./project-detail-page";
import { ProjectsPage } from "./projects-page";

const P = "p-1";
const project = (over: Record<string, unknown> = {}) => ({
  id: P,
  team_id: "t-1",
  slug: "launch",
  name: "Launch",
  description: "The Q4 launch",
  instructions: "Answer in French.",
  default_agent_id: null,
  members_mode: "selected",
  my_role: "owner",
  file_count: 1,
  created_by: "u-me",
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
  archived_at: null,
  ...over,
});
const member = (user_id: string, role = "member") => ({
  user_id,
  role,
  added_at: "2026-10-02T10:00:00Z",
});
const file = (over: Record<string, unknown> = {}) => ({
  id: "f-1",
  project_id: P,
  path: "brief.md",
  size_bytes: 2048,
  sha256: "a".repeat(64),
  mime_type: "text/markdown",
  source: "upload",
  added_by: "u-me",
  added_at: "2026-10-02T10:00:00Z",
  ...over,
});
const ROSTER = {
  members: [
    {
      user_id: "u-me",
      name: "Ada",
      email: "ada@x.io",
      role: "builder",
      joined_at: "2026-01-01T00:00:00Z",
    },
    {
      user_id: "u-bob",
      name: "Bob",
      email: "bob@x.io",
      role: "member",
      joined_at: "2026-01-01T00:00:00Z",
    },
    {
      user_id: "u-cy",
      name: "Cy",
      email: "cy@x.io",
      role: "member",
      joined_at: "2026-01-01T00:00:00Z",
    },
  ],
};
const AGENTS = {
  agents: [
    { id: "a-team", scope: "team", name: "Analyst" },
    { id: "a-me", scope: "personal", name: "Mine" },
  ],
  next_cursor: null,
};
const base = (over: Record<string, unknown> = {}) => ({
  [`GET /v1/projects/${P}`]: [200, project(over)] as const,
  [`GET /v1/projects/${P}/members`]: [
    200,
    { members_mode: "selected", members: [member("u-me", "owner"), member("u-bob")] },
  ] as const,
  [`GET /v1/projects/${P}/files`]: [200, { files: [file()] }] as const,
  [`GET /v1/threads?project_id=${P}`]: [200, { threads: [], next_cursor: null }] as const,
  "GET /v1/team/members": [200, ROSTER] as const,
  "GET /v1/agents/runnable?limit=200": [200, AGENTS] as const,
});

const memberRow = async (name: string) =>
  (await screen.findByRole("rowheader", { name })).closest("tr") as HTMLElement;

beforeEach(() =>
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("projects list and create (KOBE-164, ac-1)", () => {
  it("lists visible projects and links to each", async () => {
    stubApi({
      "GET /v1/projects": [
        200,
        { projects: [project(), project({ id: "p-2", name: "Ops", my_role: null })] },
      ],
      "GET /v1/agents/runnable?limit=200": [200, AGENTS],
    });
    renderTeam(<ProjectsPage />, { role: "member" });
    const link = await screen.findByRole("link", { name: "Launch" });
    expect(link.getAttribute("href")).toBe(`/me/projects/${P}`);
    expect(screen.getByText("Team admin")).toBeTruthy();
    // A plain member cannot create projects.
    expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
  });

  it("creates a project with instructions, a team agent and selected members", async () => {
    const calls = stubApi({
      "GET /v1/projects": [200, { projects: [] }],
      "GET /v1/agents/runnable?limit=200": [200, AGENTS],
      "POST /v1/projects": [201, project()],
    });
    renderTeam(<ProjectsPage />, { role: "builder" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("Name"), "Launch");
    await user.type(screen.getByLabelText("Instructions"), "Answer in French.");
    // Personal agents are not offered: the server only accepts team and gallery agents.
    const agent = screen.getByLabelText("Default agent");
    expect(within(agent).queryByText("Mine")).toBeNull();
    await user.selectOptions(agent, "Analyst");
    await user.selectOptions(screen.getByLabelText("Members"), "Selected people only");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await screen.findByText("Created Launch.");
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({
      name: "Launch",
      description: "",
      instructions: "Answer in French.",
      default_agent_id: "a-team",
      members_mode: "selected",
      member_user_ids: [],
    });
    expect(post.headers.get("x-kobe-team")).toBe("t-1");
  });

  it("explains a taken web name", async () => {
    stubApi({
      "GET /v1/projects": [200, { projects: [] }],
      "GET /v1/agents/runnable?limit=200": [200, AGENTS],
      "POST /v1/projects": [409, { code: "slug_taken", message: "taken" }],
    });
    renderTeam(<ProjectsPage />, { role: "team_admin" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("Name"), "Launch");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("Another project already uses that web name.")).toBeTruthy();
  });

  it("refuses instructions over 8 KiB before sending", async () => {
    const calls = stubApi({
      "GET /v1/projects": [200, { projects: [] }],
      "GET /v1/agents/runnable?limit=200": [200, AGENTS],
    });
    renderTeam(<ProjectsPage />, { role: "builder" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("Name"), "Big");
    await user.click(screen.getByLabelText("Instructions"));
    await user.paste("x".repeat(8 * 1024 + 1));
    expect(screen.getByRole("alert").textContent).toMatch(/Too long/);
    expect(
      (screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("shows archived projects only when asked", async () => {
    const calls = stubApi({
      "GET /v1/projects": [200, { projects: [] }],
      "GET /v1/projects?include_archived=true": [
        200,
        { projects: [project({ archived_at: "2026-10-03T10:00:00Z" })] },
      ],
      "GET /v1/agents/runnable?limit=200": [200, AGENTS],
    });
    renderTeam(<ProjectsPage />, { role: "member" });
    await screen.findByText("No projects yet.");
    await userEvent.setup().click(screen.getByLabelText("Show archived projects"));
    expect(await screen.findByText(/\(archived\)/)).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain("/v1/projects?include_archived=true");
  });
});

describe("project detail (KOBE-164, ac-1)", () => {
  it("edits settings with only the changed form values", async () => {
    const calls = stubApi({
      ...base(),
      [`PATCH /v1/projects/${P}`]: [200, project({ name: "Launch 2" })],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "builder" });
    const user = userEvent.setup();
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Launch 2");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    const patch = must(calls.find((c) => c.method === "PATCH"));
    expect(JSON.parse(String(patch.body))).toMatchObject({ name: "Launch 2" });
  });

  it("archives with confirmation and shows an archived project read-only", async () => {
    const calls = stubApi({
      ...base(),
      [`PATCH /v1/projects/${P}`]: [200, project({ archived_at: "2026-10-03T10:00:00Z" })],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "builder" });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Archive project" }));
    await waitFor(() =>
      expect(JSON.parse(String(calls.find((c) => c.method === "PATCH")?.body))).toEqual({
        archived: true,
      }),
    );
  });

  it("makes an archived project read-only for everyone", async () => {
    stubApi(base({ archived_at: "2026-10-03T10:00:00Z" }));
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "team_admin" });
    expect(await screen.findByText(/This project is archived and read-only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("form", { name: "Add a member" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Add a file" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete brief/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "New conversation in this project" })).toBeNull();
    // Restoring stays possible for an admin.
    expect(screen.getByRole("button", { name: "Restore project" })).toBeTruthy();
  });

  it("hides management from a plain member but keeps reading", async () => {
    stubApi(base({ my_role: "member" }));
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "member" });
    expect(await screen.findByText(/Only the project's owners and team admins/)).toBeTruthy();
    await screen.findByText("brief.md");
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive project" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Add a member" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Add a file" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete brief/ })).toBeNull();
    expect(
      screen.getByRole("link", { name: "New conversation in this project" }).getAttribute("href"),
    ).toBe(`/?project=${P}`);
    expect(screen.getByRole("link", { name: "Project memory" }).getAttribute("href")).toBe(
      `/me/memory?project=${P}`,
    );
  });

  it("lets a team admin who is not a member manage but not open memory", async () => {
    stubApi(base({ my_role: null }));
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "team_admin" });
    await screen.findByRole("button", { name: "Save changes" }).catch(() => undefined);
    expect(await screen.findByRole("button", { name: "Archive project" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Project memory" })).toBeNull();
  });

  it("shows the server's 404 for a project you cannot see", async () => {
    stubApi({
      [`GET /v1/projects/${P}`]: [404, { code: "not_found", message: "No such project." }],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "member" });
    expect(await screen.findByText("No such project.")).toBeTruthy();
  });
});

describe("project members (KOBE-164, ac-1)", () => {
  it("adds a person who is not yet a member, with a role", async () => {
    const calls = stubApi({
      ...base(),
      [`POST /v1/projects/${P}/members`]: [201, member("u-cy", "owner")],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "builder" });
    const form = within(await screen.findByRole("form", { name: "Add a member" }));
    const user = userEvent.setup();
    // Bob is already in: only Cy is offered (and Ada, who owns it, is listed already).
    expect(form.queryByRole("option", { name: /Bob/ })).toBeNull();
    await user.selectOptions(form.getByLabelText("Person"), "Cy (cy@x.io)");
    await user.selectOptions(form.getByLabelText("Role"), "owner");
    await user.click(form.getByRole("button", { name: "Add member" }));
    await screen.findByText("Added Cy.");
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({ user_id: "u-cy", role: "owner" });
  });

  it("changes a role and removes a member after confirming", async () => {
    const calls = stubApi({
      ...base(),
      [`PATCH /v1/projects/${P}/members/u-bob`]: [200, member("u-bob", "owner")],
      [`DELETE /v1/projects/${P}/members/u-bob`]: [204],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "builder" });
    const user = userEvent.setup();
    const row = within(await memberRow("Bob"));
    await user.selectOptions(row.getByLabelText("Project role of Bob"), "owner");
    await user.click(row.getByRole("button", { name: /Save/ }));
    await screen.findByText("Bob is now owner.");
    expect(JSON.parse(String(calls.find((c) => c.method === "PATCH")?.body))).toEqual({
      role: "owner",
    });
    await user.click(within(await memberRow("Bob")).getByRole("button", { name: /Remove/ }));
    await screen.findByText("Removed Bob.");
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/members/u-bob"))).toBe(true);
  });

  it("explains the last-owner refusal", async () => {
    stubApi({
      ...base(),
      [`DELETE /v1/projects/${P}/members/u-me`]: [409, { code: "last_owner", message: "x" }],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "builder" });
    await userEvent
      .setup()
      .click(within(await memberRow("Ada (you)")).getByRole("button", { name: /Remove/ }));
    expect(await screen.findByText("A project keeps at least one owner.")).toBeTruthy();
  });

  it("says that in team mode only owners are listed", async () => {
    stubApi({
      ...base({ members_mode: "team" }),
      [`GET /v1/projects/${P}/members`]: [
        200,
        { members_mode: "team", members: [member("u-me", "owner")] },
      ],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "builder" });
    expect(await screen.findByText(/Everyone in the team is a member/)).toBeTruthy();
  });
});

describe("project files (KOBE-164, ac-1)", () => {
  it("lists files and marks approved agent proposals", async () => {
    stubApi({
      ...base(),
      [`GET /v1/projects/${P}/files`]: [
        200,
        {
          files: [
            file(),
            file({
              id: "f-2",
              path: "notes/idea.txt",
              source: "proposal",
              added_by: "u-bob",
              size_bytes: 12,
            }),
          ],
        },
      ],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "builder" });
    await screen.findByRole("rowheader", { name: /notes\/idea\.txt/ });
    expect(screen.getByText("2.0 KiB")).toBeTruthy();
    expect(screen.getAllByText("Proposed by an agent, approved")).toHaveLength(1);
    expect(
      screen.getByText(/added only after the person in that conversation approves it/),
    ).toBeTruthy();
  });

  it("uploads a file into a folder as multipart with the folder first", async () => {
    const calls = stubApi({
      ...base(),
      [`POST /v1/projects/${P}/files`]: [201, file({ path: "docs/a.txt" })],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "builder" });
    const form = within(await screen.findByRole("form", { name: "Add a file" }));
    const user = userEvent.setup();
    await user.type(form.getByLabelText("Folder (optional)"), "docs");
    await user.upload(
      form.getByLabelText("File"),
      new File(["hi"], "a.txt", { type: "text/plain" }),
    );
    await user.click(form.getByRole("button", { name: "Upload file" }));
    await screen.findByText("Added a.txt.");
    const post = must(calls.find((c) => c.method === "POST"));
    const body = post.body as FormData;
    expect([...body.keys()]).toEqual(["path", "file"]);
    expect(body.get("path")).toBe("docs");
    expect((body.get("file") as File).name).toBe("a.txt");
  });

  it("deletes a file after confirming; a refusal is shown", async () => {
    const calls = stubApi({
      ...base(),
      [`DELETE /v1/projects/${P}/files/f-1`]: [204],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "builder" });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Delete brief.md" }));
    await screen.findByText("Deleted brief.md.");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("renders names, instructions and file names as plain text", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    stubApi({
      ...base({ name: evil, description: evil, instructions: evil }),
      [`GET /v1/projects/${P}/files`]: [200, { files: [file({ path: evil })] }],
      [`GET /v1/threads?project_id=${P}`]: [
        200,
        {
          threads: [
            {
              thread_id: "th-1",
              title: evil,
              status: "idle",
              owner_user_id: "u-bob",
              project_id: P,
              shared_to_project: true,
              last_activity_at: "2026-10-02T10:00:00Z",
            },
          ],
          next_cursor: null,
        },
      ],
    });
    const { container } = renderTeam(<ProjectDetailPage projectId={P} />, { role: "builder" });
    await screen.findByRole("heading", { name: evil });
    await screen.findByRole("link", { name: evil });
    expect(container.querySelector("img")).toBeNull();
    expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe(evil);
  });
});

describe("project conversations (KOBE-164, ac-2)", () => {
  it("lists own and shared conversations; shared ones say read-only", async () => {
    stubApi({
      ...base(),
      [`GET /v1/threads?project_id=${P}`]: [
        200,
        {
          threads: [
            {
              thread_id: "th-1",
              title: "Mine",
              owner_user_id: "u-me",
              shared_to_project: true,
              last_activity_at: "2026-10-02T10:00:00Z",
            },
            {
              thread_id: "th-2",
              title: "Bob's plan",
              owner_user_id: "u-bob",
              shared_to_project: true,
              last_activity_at: "2026-10-02T09:00:00Z",
            },
          ],
          next_cursor: null,
        },
      ],
    });
    renderTeam(<ProjectDetailPage projectId={P} />, { role: "builder" });
    expect((await screen.findByRole("link", { name: "Bob's plan" })).getAttribute("href")).toBe(
      "/?thread=th-2",
    );
    expect(screen.getByText(/yours, shared with the project/)).toBeTruthy();
    expect(screen.getByText(/shared by Bob, read-only/)).toBeTruthy();
  });
});
