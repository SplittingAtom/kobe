// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { AgentBuilderPage } from "../admin/team/agent-builder/agent-builder-page";
import { TEAM, ME, renderTeam, stubApi } from "../admin/testing";
import { MyAgentsPage } from "./my-agents-page";
import { MyAgentsShell } from "./my-agents-shell";

const MINE = {
  id: "p-1",
  scope: "personal",
  slug: "notes",
  name: "Notes",
  status: "active",
  ownerUserId: ME.id,
  currentVersion: null,
  revision: 1,
  updatedAt: "2026-10-01T10:00:00Z",
  canEdit: true,
  canPublish: true,
  canExport: true,
  starters: [],
  frontmatter: { name: "Notes" },
  prompt: "Take notes.",
};
const MODELS = { models: [], default: null };
const READ = {
  "GET /v1/team/models": [200, MODELS],
  "GET /v1/agents/p-1": [200, { agent: MINE }],
  "GET /v1/agents/p-1/versions": [200, { current_version: null, versions: [], next_before: null }],
} as const;

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign, reload: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// A plain member: no team.agents.* permission at all.
const asMember = { role: "member", permissions: ["team.read"] } as const;

describe("My agents list", () => {
  it("lists only personal agents and links to the builder", async () => {
    const calls = stubApi({
      "GET /v1/agents?scope=personal&include_archived=true": [200, { agents: [MINE] }],
    });
    renderTeam(<MyAgentsPage />, asMember);
    const edit = await screen.findByRole("link", { name: /Edit\s+Notes/ });
    expect(edit.getAttribute("href")).toBe("/me/agents/p-1");
    expect(screen.getByRole("link", { name: "New agent" }).getAttribute("href")).toBe(
      "/me/agents/new",
    );
    expect(calls.map((c) => c.url)).toEqual(["/v1/agents?scope=personal&include_archived=true"]);
  });

  it("says so when there are none", async () => {
    stubApi({ "GET /v1/agents?scope=personal&include_archived=true": [200, { agents: [] }] });
    renderTeam(<MyAgentsPage />, asMember);
    expect(await screen.findByText(/no personal agents yet/i)).toBeTruthy();
  });
});

describe("Personal agent builder", () => {
  it("creates a personal agent without any admin permission and opens it in my area", async () => {
    const calls = stubApi({
      "GET /v1/team/models": [200, MODELS],
      "POST /v1/agents": [201, { agent: { ...MINE, id: "p-9" } }],
    });
    renderTeam(<AgentBuilderPage scope="personal" />, asMember);
    expect(screen.getByRole("heading", { name: "New personal agent" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "My agents" }).getAttribute("href")).toBe("/me/agents");
    await userEvent.type(screen.getByLabelText("Name"), "Notes");
    await userEvent.type(screen.getByLabelText("System prompt"), "Take notes.");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/me/agents/p-9"));
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toMatchObject({ scope: "personal" });
  });

  it("edits and publishes the owner's agent", async () => {
    const calls = stubApi({
      ...READ,
      "PUT /v1/agents/p-1": [200, { agent: { ...MINE, revision: 2, prompt: "Be brief." } }],
      "POST /v1/agents/p-1/publish": [
        201,
        {
          agent: { ...MINE, revision: 2, currentVersion: 1 },
          version: {
            version: 1,
            publishedBy: ME.id,
            publishedAt: "2026-10-02T10:00:00Z",
            draftRevision: 2,
            republishedFrom: null,
          },
        },
      ],
    });
    renderTeam(<AgentBuilderPage scope="personal" agentId="p-1" />, asMember);
    const prompt = await screen.findByLabelText("System prompt");
    await userEvent.clear(prompt);
    await userEvent.type(prompt, "Be brief.");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    await userEvent.click(screen.getByRole("button", { name: /Publish/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Publish( v|$)/ }));
    await screen.findByText("Published v1.");
    expect(calls.some((c) => c.method === "POST" && c.url === "/v1/agents/p-1/publish")).toBe(true);
  });

  it("shows another member's agent as unavailable (the server answers 404)", async () => {
    stubApi({
      "GET /v1/team/models": [200, MODELS],
      "GET /v1/agents/p-2": [404, { code: "not_found", message: "Agent not found." }],
    });
    renderTeam(<AgentBuilderPage scope="personal" agentId="p-2" />, asMember);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByLabelText("System prompt")).toBeNull();
  });

  it("keeps the team builder pointing at the admin console", async () => {
    stubApi({ "GET /v1/team/models": [200, MODELS] });
    renderTeam(<AgentBuilderPage />);
    expect(screen.getByRole("link", { name: "All team agents" })).toBeTruthy();
  });
});

describe("My agents shell", () => {
  const access = {
    console: "team",
    user: ME,
    team: TEAM,
    role: "member",
    permissions: ["team.read"],
  } as const;

  it("renders its page for any team member", async () => {
    render(
      <MyAgentsShell loadAccess={async () => ({ ok: true, status: 200, data: access })}>
        <p>inside</p>
      </MyAgentsShell>,
    );
    expect(await screen.findByText("inside")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Kobe" }).getAttribute("href")).toBe("/");
  });

  it("explains a failed access check instead of rendering the page", async () => {
    render(
      <MyAgentsShell
        loadAccess={async () => ({
          ok: false,
          error: { status: 401, code: "unauthenticated", message: "Sign in first." },
        })}
      >
        <p>inside</p>
      </MyAgentsShell>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("inside")).toBeNull();
  });
});
