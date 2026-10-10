// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { renderTeam, stubApi } from "../admin/testing";
import { MyMemoryPage } from "./my-memory-page";

const DOC = "00000000-0000-4000-8000-0000000d0c01";
const MEMBER = { role: "member", permissions: ["team.chat"] } as const;
const summary = (over: Record<string, unknown> = {}) => ({
  id: DOC,
  scope: "user",
  path: "MEMORY.md",
  current_version: 2,
  size_bytes: 12,
  updated_at: "2026-10-09T10:00:00Z",
  updated_by: null,
  ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ...summary(),
  content: "- likes tea",
  versions: [
    { version: 2, size_bytes: 12, created_at: "2026-10-09T10:00:00Z", source: "agent" },
    { version: 1, size_bytes: 5, created_at: "2026-10-08T10:00:00Z", source: "panel" },
  ],
  ...over,
});
const LIST = "/v1/memory?scope=user";
const ONE = `/v1/memory/${DOC}`;

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

describe("Memory panel (KOBE-158, ac-2)", () => {
  it("lists the personal memory files and opens one with its provenance", async () => {
    stubApi({
      [`GET ${LIST}`]: [200, { docs: [summary(), summary({ id: "d2", path: "topics/food.md" })] }],
      [`GET ${ONE}`]: [200, detail()],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByRole("button", { name: "Open MEMORY.md" });
    expect(screen.getByRole("button", { name: "Open topics/food.md" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open MEMORY.md" }));
    expect((await screen.findByLabelText("Memory content")).textContent).toBe("- likes tea");
    expect(screen.getByText(/Current version 2, written by the agent/)).toBeTruthy();
    const history = within(screen.getByRole("list", { name: "Version history" }));
    expect(history.getByText(/Version 1.*edited in the panel/)).toBeTruthy();
  });

  it("says when there is no memory yet", async () => {
    stubApi({ [`GET ${LIST}`]: [200, { docs: [] }] });
    renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByText(/No memory files yet/);
  });

  it("edits a file with the version it opened (optimistic concurrency)", async () => {
    const calls = stubApi({
      [`GET ${LIST}`]: [200, { docs: [summary()] }],
      [`GET ${ONE}`]: [
        [200, detail()],
        [200, detail({ content: "- likes coffee", current_version: 3 })],
      ],
      "PUT /v1/memory": [200, detail({ content: "- likes coffee", current_version: 3 })],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(await screen.findByRole("button", { name: "Open MEMORY.md" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const box = screen.getByLabelText("Edit MEMORY.md");
    await userEvent.clear(box);
    await userEvent.type(box, "- likes coffee");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({
      scope: "user",
      path: "MEMORY.md",
      content: "- likes coffee",
      expected_version: 2,
    });
    expect((await screen.findByLabelText("Memory content")).textContent).toBe("- likes coffee");
  });

  it("explains a conflicting edit", async () => {
    stubApi({
      [`GET ${LIST}`]: [200, { docs: [summary()] }],
      [`GET ${ONE}`]: [200, detail()],
      "PUT /v1/memory": [409, { code: "version_conflict", message: "moved", current_version: 5 }],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(await screen.findByRole("button", { name: "Open MEMORY.md" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.type(screen.getByLabelText("Edit MEMORY.md"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/changed since you opened it/);
  });

  it("deletes a file after confirming, and the list refreshes", async () => {
    const calls = stubApi({
      [`GET ${LIST}`]: [
        [200, { docs: [summary()] }],
        [200, { docs: [] }],
      ],
      [`GET ${ONE}`]: [200, detail()],
      [`DELETE ${ONE}`]: [204],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(await screen.findByRole("button", { name: "Open MEMORY.md" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByText(/No memory files yet/);
    expect(calls.some((c) => c.method === "DELETE" && c.url === ONE)).toBe(true);
    expect(screen.queryByLabelText("Memory content")).toBeNull();
  });

  it("does not delete when the person cancels", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const calls = stubApi({
      [`GET ${LIST}`]: [200, { docs: [summary()] }],
      [`GET ${ONE}`]: [200, detail()],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(await screen.findByRole("button", { name: "Open MEMORY.md" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("restores an earlier version from the history", async () => {
    const calls = stubApi({
      [`GET ${LIST}`]: [200, { docs: [summary()] }],
      [`GET ${ONE}`]: [200, detail()],
      [`POST ${ONE}/restore`]: [200, detail({ current_version: 3, content: "old" })],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(await screen.findByRole("button", { name: "Open MEMORY.md" }));
    await userEvent.click(await screen.findByRole("button", { name: "Restore version 1" }));
    await screen.findByText("Restored.");
    expect(JSON.parse(String(must(calls.find((c) => c.method === "POST")).body))).toEqual({
      version: 1,
    });
  });

  it("shows content as plain text: no HTML or markdown, hidden characters escaped", async () => {
    stubApi({
      [`GET ${LIST}`]: [200, { docs: [summary({ path: "a‮b.md" })] }],
      [`GET ${ONE}`]: [
        200,
        detail({ content: "[click](https://evil.example) <img src=x onerror=alert(1)> a​b‮c" }),
      ],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await userEvent.click(await screen.findByRole("button", { name: /Open a\\u202eb\.md/ }));
    const pre = await screen.findByLabelText("Memory content");
    expect(pre.textContent).toBe(
      "[click](https://evil.example) <img src=x onerror=alert(1)> a\\u200bb\\u202ec",
    );
    expect(pre.querySelector("a, img")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/hidden characters/)).toBeTruthy();
  });

  it("lists a project's memory when opened for that project", async () => {
    const project = "00000000-0000-4000-8000-0000000b0001";
    window.history.replaceState(null, "", `/me/memory?project=${project}`);
    stubApi({
      [`GET /v1/memory?scope=project&project_id=${project}`]: [
        200,
        { docs: [summary({ scope: "project", path: "plan.md" })] },
      ],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByRole("button", { name: "Open plan.md" });
    expect(screen.getByRole("heading", { name: "Project memory" })).toBeTruthy();
    window.history.replaceState(null, "", "/");
  });

  it("shows why memory is unavailable when it is switched off", async () => {
    stubApi({ [`GET ${LIST}`]: [403, { code: "memory_disabled", message: "off" }] });
    renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByText(/Memory is turned off for this team/);
  });
});

describe("Memory panel project picker (KOBE-164)", () => {
  const PROJECT = "00000000-0000-4000-8000-0000000000a1";
  const project = (over: Record<string, unknown> = {}) => ({
    id: PROJECT,
    team_id: "t-1",
    slug: "launch",
    name: "Launch",
    description: "",
    instructions: "",
    default_agent_id: null,
    members_mode: "team",
    my_role: "member",
    file_count: 0,
    created_by: "u-me",
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:00:00Z",
    archived_at: null,
    ...over,
  });

  afterEach(() => window.history.replaceState(null, "", "/"));

  it("switches between my memory and a project's, and keeps the choice in the address", async () => {
    window.history.replaceState(null, "", "/me/memory");
    const calls = stubApi({
      "GET /v1/projects?include_archived=true": [
        200,
        { projects: [project(), project({ id: "p-admin", name: "Not mine", my_role: null })] },
      ],
      [`GET ${LIST}`]: [200, { docs: [summary()] }],
      [`GET /v1/memory?scope=project&project_id=${PROJECT}`]: [
        200,
        { docs: [summary({ id: "pd1", scope: "project", path: "plan.md" })] },
      ],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByRole("button", { name: "Open MEMORY.md" });
    const picker = await screen.findByLabelText("Memory of");
    // A team admin who is not a member would only get 404s: not offered.
    expect(within(picker).queryByRole("option", { name: "Not mine" })).toBeNull();
    await userEvent.selectOptions(picker, "Launch");
    expect(await screen.findByRole("button", { name: "Open plan.md" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Project memory" })).toBeTruthy();
    expect(window.location.search).toBe(`?project=${PROJECT}`);
    await userEvent.selectOptions(picker, "Me");
    await screen.findByRole("button", { name: "Open MEMORY.md" });
    expect(window.location.search).toBe("");
    expect(calls.map((c) => c.url)).toContain(`/v1/memory?scope=project&project_id=${PROJECT}`);
  });

  it("starts on the project from ?project= and shows no picker when there are none", async () => {
    window.history.replaceState(null, "", `/me/memory?project=${PROJECT}`);
    stubApi({
      "GET /v1/projects?include_archived=true": [200, { projects: [project()] }],
      [`GET /v1/memory?scope=project&project_id=${PROJECT}`]: [200, { docs: [] }],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    expect(await screen.findByRole("heading", { name: "Project memory" })).toBeTruthy();
    expect(((await screen.findByLabelText("Memory of")) as HTMLSelectElement).value).toBe(PROJECT);
    cleanup();
    window.history.replaceState(null, "", "/me/memory");
    stubApi({
      "GET /v1/projects?include_archived=true": [200, { projects: [] }],
      [`GET ${LIST}`]: [200, { docs: [] }],
    });
    renderTeam(<MyMemoryPage />, MEMBER);
    await screen.findByText(/No memory files yet/);
    expect(screen.queryByLabelText("Memory of")).toBeNull();
  });
});
