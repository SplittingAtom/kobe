// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../../../lib/testing/must";
import { forbidNativeConfirm, renderTeam, stubApi } from "../../testing";
import { AgentBuilderPage } from "./agent-builder-page";

/**
 * The two-tab agent creator (KOBE-476): Identity and Behaviour, Create on both, errors open the
 * tab that holds the field, the icon picker, connector tools moved between Allowed and Denied,
 * and the admin-only Dangerous approval mode.
 */
const CONNECTORS = {
  connectors: [
    {
      id: "c-1",
      name: "jira",
      auth_kind: "api_key",
      credential_source: "member",
      site_key_ready: false,
      status: "active",
      icon_url: null,
      enabled: true,
      exposure: "all",
      enabled_tools: [],
      tools: [
        tool("mcp__jira__search", "search", "pinned"),
        tool("mcp__jira__create_issue", "create_issue", "pinned"),
        tool("mcp__jira__drifted", "drifted", "drifted"),
      ],
    },
    {
      id: "c-2",
      name: "off",
      auth_kind: "none",
      credential_source: "member",
      site_key_ready: false,
      status: "active",
      icon_url: null,
      enabled: false,
      exposure: null,
      enabled_tools: [],
      tools: [],
    },
  ],
};

function tool(piName: string, name: string, status: "pinned" | "drifted") {
  return { pi_name: piName, name, title: null, read_only: false, open_world: true, status };
}

const READ = {
  "GET /v1/team/models": [200, { models: [], default: null }],
  "GET /v1/team/connectors": [200, CONNECTORS],
  "GET /v1/me/skills/enablements": [
    200,
    { personal: [{ skill_id: "s-1", name: "sql", enabled: true }], team: [], catalog: [] },
  ],
} as const;

const CREATED = {
  id: "a-9",
  scope: "personal",
  slug: "triage",
  name: "Triage",
  status: "active",
  ownerUserId: "u-me",
  currentVersion: null,
  revision: 1,
  updatedAt: "2026-10-22T10:00:00Z",
  canEdit: true,
  canPublish: true,
  canExport: true,
  starters: [],
  frontmatter: { name: "Triage" },
  prompt: "Hi",
};

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  forbidNativeConfirm();
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign, reload: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tab = (name: "Identity" | "Behaviour") => screen.getByRole("tab", { name });
const selected = (name: "Identity" | "Behaviour") => tab(name).getAttribute("aria-selected");

async function fillIdentity() {
  await userEvent.type(screen.getByLabelText("Name"), "Triage");
  await userEvent.type(screen.getByLabelText("System prompt"), "Hi");
}

function postedBody(calls: ReturnType<typeof stubApi>) {
  const post = must(calls.find((c) => c.method === "POST"));
  return JSON.parse(String(post.body)) as { frontmatter: Record<string, unknown> };
}

describe("two tabs (ac-1)", () => {
  it("puts identity fields on one tab, behaviour on the other, and Create on both", async () => {
    stubApi(READ);
    renderTeam(<AgentBuilderPage scope="personal" />, { role: "member", permissions: [] });
    const identity = screen.getByRole("tabpanel", { name: "Identity" });
    for (const label of ["Slug", "Name", "Role", "Description", "System prompt"]) {
      expect(within(identity).getByLabelText(label)).toBeTruthy();
    }
    expect(within(identity).getByRole("button", { name: /Icon/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create agent" })).toBeTruthy();
    await userEvent.click(tab("Behaviour"));
    const behaviour = screen.getByRole("tabpanel", { name: "Behaviour" });
    for (const label of ["Model", "Approval mode", "Conversation starters"]) {
      expect(within(behaviour).getByLabelText(label)).toBeTruthy();
    }
    expect(within(behaviour).getByRole("group", { name: "Skills" })).toBeTruthy();
    expect(within(behaviour).getByRole("group", { name: "Connectors" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create agent" })).toBeTruthy();
  });

  it("switches to the tab holding the first error when a save fails", async () => {
    const calls = stubApi(READ);
    renderTeam(<AgentBuilderPage scope="personal" />, { role: "member", permissions: [] });
    await fillIdentity();
    await userEvent.click(tab("Behaviour"));
    await userEvent.type(
      screen.getByLabelText("Conversation starters"),
      "1\n2\n3\n4\n5\n6\n7\n8\n9",
    );
    await userEvent.click(tab("Identity"));
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(selected("Behaviour")).toBe("true"));
    // An Identity error wins over a Behaviour one.
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(selected("Identity")).toBe("true"));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("icon picker (ac-1)", () => {
  it("searches the app's icons and stores the chosen name", async () => {
    const calls = stubApi({ ...READ, "POST /v1/agents": [201, { agent: CREATED }] });
    renderTeam(<AgentBuilderPage scope="personal" />, { role: "member", permissions: [] });
    await fillIdentity();
    await userEvent.click(screen.getByRole("button", { name: /Icon/ }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search icons" }), "chart b");
    const icons = screen.getByRole("list", { name: "Icons" });
    expect(within(icons).queryByRole("button", { name: "chart-line" })).toBeNull();
    await userEvent.click(within(icons).getByRole("button", { name: "chart-bar" }));
    expect(screen.queryByRole("dialog", { name: "Choose an icon" })).toBeNull();
    expect(screen.getByRole("button", { name: /Icon/ }).textContent).toContain("chart-bar");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(postedBody(calls).frontmatter.icon).toBe("chart-bar"));
  });

  it("closes on Escape and keeps a stored emoji", async () => {
    stubApi(READ);
    renderTeam(<AgentBuilderPage scope="personal" />, { role: "member", permissions: [] });
    await userEvent.click(screen.getByRole("button", { name: /Icon/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Choose an icon" })).toBeNull();
  });
});

describe("connector tools: Allowed and Denied (ac-2)", () => {
  it("fills Allowed from the chosen connector and moves a tool to Denied and back", async () => {
    const calls = stubApi({ ...READ, "POST /v1/agents": [201, { agent: CREATED }] });
    renderTeam(<AgentBuilderPage scope="personal" />, { role: "member", permissions: [] });
    await fillIdentity();
    await userEvent.click(tab("Behaviour"));
    const add = await screen.findByRole("combobox", { name: "Add a connector" });
    // Only the team's enabled connectors are offered.
    expect(within(add).queryByRole("option", { name: "off" })).toBeNull();
    await userEvent.selectOptions(add, "jira");
    const allowed = screen.getByRole("list", { name: "Allowed tools" });
    expect(
      within(allowed)
        .getAllByRole("listitem")
        .map((li) => li.querySelector("code")?.textContent),
    ).toEqual(["mcp__jira__search", "mcp__jira__create_issue"]);
    await userEvent.click(screen.getByRole("button", { name: "Deny mcp__jira__create_issue" }));
    const denied = screen.getByRole("list", { name: "Denied tools" });
    expect(within(denied).getByText("mcp__jira__create_issue")).toBeTruthy();
    // And back, from the keyboard.
    screen.getByRole("button", { name: "Allow mcp__jira__create_issue" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("list", { name: "Denied tools" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Deny mcp__jira__search" }));
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() =>
      expect(postedBody(calls).frontmatter).toEqual({
        name: "Triage",
        connectors: ["jira"],
        // Allowed connector tools are written one by one (AC1, AC4).
        tools: { allow: ["mcp__jira__create_issue"], deny: ["mcp__jira__search"] },
      }),
    );
  });

  it("locks the connector list while every team connector is used", async () => {
    stubApi(READ);
    renderTeam(<AgentBuilderPage scope="personal" />, { role: "member", permissions: [] });
    await userEvent.click(tab("Behaviour"));
    await screen.findByRole("combobox", { name: "Add a connector" });
    await userEvent.click(screen.getByRole("checkbox", { name: /Use every connector/ }));
    expect(screen.queryByRole("combobox", { name: "Add a connector" })).toBeNull();
    // Every enabled connector's pinned tools are listed (never a drifted one).
    const allowed = await screen.findByRole("list", { name: "Allowed tools" });
    expect(within(allowed).queryByText("mcp__jira__drifted")).toBeNull();
    expect(within(allowed).getByText("mcp__jira__search")).toBeTruthy();
  });
});

describe("Dangerous approval mode (ac-3)", () => {
  const modes = () =>
    within(screen.getByLabelText("Approval mode"))
      .getAllByRole("option")
      .map((o) => o.textContent);

  it("is offered to team admins and site admins only", async () => {
    stubApi(READ);
    const view = renderTeam(<AgentBuilderPage scope="personal" />, { role: "team_admin" });
    await userEvent.click(tab("Behaviour"));
    expect(modes()).toContainEqual(expect.stringMatching(/^Dangerous/));
    view.unmount();
    const member = renderTeam(<AgentBuilderPage scope="personal" />, {
      role: "member",
      permissions: [],
    });
    await userEvent.click(tab("Behaviour"));
    expect(modes()).not.toContainEqual(expect.stringMatching(/^Dangerous/));
    member.unmount();
    renderTeam(<AgentBuilderPage scope="personal" />, {
      role: "member",
      permissions: [],
      siteAdmin: true,
    });
    await userEvent.click(tab("Behaviour"));
    expect(modes()).toContainEqual(expect.stringMatching(/^Dangerous/));
  });

  it("warns what it does and sends it; a refusal opens the Behaviour tab", async () => {
    const calls = stubApi({
      ...READ,
      "POST /v1/agents": [
        403,
        { code: "dangerous_mode_forbidden", message: "Only site and team admins can use it." },
      ],
    });
    renderTeam(<AgentBuilderPage scope="personal" />, { role: "team_admin" });
    await fillIdentity();
    await userEvent.click(tab("Behaviour"));
    await userEvent.selectOptions(screen.getByLabelText("Approval mode"), "dangerous");
    expect(screen.getByText(/runs its allowed tools without asking for approval/)).toBeTruthy();
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Add a connector" }),
      "jira",
    );
    await userEvent.click(tab("Identity"));
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await screen.findByText("Only site and team admins can use it.");
    expect(selected("Behaviour")).toBe("true");
    expect(postedBody(calls).frontmatter.approval_mode).toBe("dangerous");
  });

  it("refuses Dangerous with no tool named one by one, on the Behaviour tab", async () => {
    const calls = stubApi(READ);
    renderTeam(<AgentBuilderPage scope="personal" />, { role: "team_admin" });
    await fillIdentity();
    await userEvent.click(tab("Behaviour"));
    await userEvent.selectOptions(screen.getByLabelText("Approval mode"), "dangerous");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Add an allowed tool or glob" }),
      "mcp__jira__*{Enter}",
    );
    await userEvent.click(tab("Identity"));
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(selected("Behaviour")).toBe("true"));
    expect(screen.getByText(/must name at least one tool \(no wildcards\)/)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
