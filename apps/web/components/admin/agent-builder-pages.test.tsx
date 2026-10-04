// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { AgentBuilderPage } from "./team/agent-builder/agent-builder-page";
import { TEAM, renderTeam, stubApi } from "./testing";

const AGENT = {
  id: "a-1",
  scope: "team",
  slug: "triage",
  name: "Triage",
  status: "active",
  ownerUserId: "u-me",
  currentVersion: 2,
  revision: 3,
  updatedAt: "2026-10-01T10:00:00Z",
  canEdit: true,
  canPublish: true,
  canExport: true,
  starters: [],
  frontmatter: { name: "Triage", approval_mode: "ask-on-write" },
  prompt: "Be helpful.",
};
const VERSIONS = {
  current_version: 2,
  versions: [
    {
      version: 2,
      published_by: "u-me",
      published_at: "2026-10-02T10:00:00Z",
      draft_revision: 2,
      republished_from: null,
    },
    {
      version: 1,
      published_by: "u-me",
      published_at: "2026-10-01T10:00:00Z",
      draft_revision: 1,
      republished_from: null,
    },
  ],
  next_before: null,
};
const MODELS = {
  models: ["fast", "smart", "local"].map((alias) => ({
    alias,
    label: alias === "smart" ? "Smart" : null,
    enabled: alias !== "local",
    is_default: alias === "fast",
  })),
  default: "fast",
};
const READ = {
  "GET /v1/team/models": [200, MODELS],
  "GET /v1/agents/a-1": [200, { agent: AGENT }],
  "GET /v1/agents/a-1/versions": [200, VERSIONS],
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

describe("Agent builder: create", () => {
  it("refuses an invalid definition with field errors and sends nothing", async () => {
    const calls = stubApi(READ);
    renderTeam(<AgentBuilderPage />);
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/fix 1 problem/i);
    const name = screen.getByLabelText("Name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const describedBy = must(name.getAttribute("aria-describedby"));
    expect(document.getElementById(describedBy)?.textContent).toMatch(/empty/);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("creates a team agent from the form and opens it", async () => {
    const calls = stubApi({ "POST /v1/agents": [201, { agent: { ...AGENT, id: "a-9" } }] });
    renderTeam(<AgentBuilderPage />);
    await userEvent.type(screen.getByLabelText("Name"), "Triage");
    await userEvent.type(screen.getByLabelText("Skills"), "sql");
    await userEvent.type(screen.getByLabelText("System prompt"), "Be helpful.");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/admin/team/agents/a-9"));
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({
      scope: "team",
      frontmatter: { name: "Triage", skills: ["sql"] },
      prompt: "Be helpful.",
    });
    expect(post.headers.get("x-kobe-team")).toBe(TEAM.id);
  });
});

describe("Agent builder: edit and publish", () => {
  it("saves the draft against the revision it loaded", async () => {
    const calls = stubApi({
      ...READ,
      "PUT /v1/agents/a-1": [200, { agent: { ...AGENT, revision: 4, prompt: "Be brief." } }],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const prompt = await screen.findByLabelText("System prompt");
    expect((prompt as HTMLTextAreaElement).value).toBe("Be helpful.");
    await userEvent.clear(prompt);
    await userEvent.type(prompt, "Be brief.");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(put.headers.get("if-match")).toBe('"3"');
    expect(JSON.parse(String(put.body)).prompt).toBe("Be brief.");
    expect(JSON.parse(String(put.body)).frontmatter).toEqual(AGENT.frontmatter);
  });

  it("publishes through a dialog that shows what goes out, warnings included", async () => {
    const calls = stubApi({
      ...READ,
      "PUT /v1/agents/a-1": [
        200,
        {
          agent: { ...AGENT, revision: 4, frontmatter: { name: "Triage", approval_mode: "auto" } },
        },
      ],
      "POST /v1/agents/a-1/publish": [
        201,
        {
          agent: { ...AGENT, revision: 4, currentVersion: 7 },
          version: { ...VERSIONS.versions[0], version: 7 },
        },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await userEvent.selectOptions(await screen.findByLabelText("Approval mode"), "auto");
    // Unsaved edits can't be published: the dialog saves nothing on its own.
    expect((screen.getByRole("button", { name: "Publish…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    await userEvent.click(screen.getByRole("button", { name: "Publish…" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish Triage as v3" });
    expect(within(dialog).getByText(/auto runs only allow-listed tools/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish v3" }));
    // The notice names the version the server assigned, not currentVersion + 1.
    await screen.findByText("Published v7.");
    expect(screen.queryByRole("dialog")).toBeNull();
    const publish = must(calls.find((c) => c.url.endsWith("/publish")));
    expect(publish.headers.get("if-match")).toBe('"4"');
  });

  it("cancels the dialog with Escape and shows a publish conflict in it", async () => {
    stubApi({
      ...READ,
      "POST /v1/agents/a-1/publish": [
        412,
        { code: "revision_mismatch", message: "Someone else changed this agent." },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Publish…" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Publish…" }));
    await userEvent.click(screen.getByRole("button", { name: "Publish v3" }));
    expect((await within(screen.getByRole("dialog")).findByRole("alert")).textContent).toMatch(
      "Someone else changed this agent.",
    );
  });

  it("lets an editor without the publish right save, but offers no Publish or Restore", async () => {
    stubApi({
      ...READ,
      "GET /v1/agents/a-1": [200, { agent: { ...AGENT, canPublish: false } }],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await screen.findByRole("button", { name: "Save draft" });
    expect(screen.queryByRole("button", { name: "Publish…" })).toBeNull();
    await screen.findByRole("region", { name: "Version history" });
    await screen.findAllByRole("row");
    expect(screen.queryByRole("button", { name: /Restore version/ })).toBeNull();
  });

  it("is read-only when the caller can't edit", async () => {
    stubApi({ ...READ, "GET /v1/agents/a-1": [200, { agent: { ...AGENT, canEdit: false } }] });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    expect((await screen.findByLabelText("Name")).hasAttribute("readonly")).toBe(true);
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });
});

describe("Agent builder: version history", () => {
  it("lists versions, marks the current one and restores an earlier one", async () => {
    const calls = stubApi({
      ...READ,
      "POST /v1/agents/a-1/rollback": [
        201,
        {
          agent: {
            ...AGENT,
            revision: 5,
            currentVersion: 3,
            prompt: "Old prompt.",
            frontmatter: { name: "Triage v1" },
          },
          version: { ...VERSIONS.versions[1], version: 3, republished_from: 1 },
        },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const history = await screen.findByRole("region", { name: "Version history" });
    const rows = await within(history).findAllByRole("row");
    expect(rows).toHaveLength(3); // header + 2 versions
    expect(within(must(rows[1])).getByText("Current")).toBeTruthy();
    expect(within(history).queryByRole("button", { name: "Restore version 2" })).toBeNull();
    await userEvent.click(within(history).getByRole("button", { name: "Restore version 1" }));
    await screen.findByText("Restored v1 as v3.");
    const post = must(calls.find((c) => c.url.endsWith("/rollback")));
    expect(JSON.parse(String(post.body))).toEqual({ version: 1 });
    expect((screen.getByLabelText("System prompt") as HTMLTextAreaElement).value).toBe(
      "Old prompt.",
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Triage v1");
  });

  it("doesn't restore when the user declines the confirmation", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const calls = stubApi(READ);
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Restore version 1" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("loads older versions on request", async () => {
    const calls = stubApi({
      ...READ,
      "GET /v1/agents/a-1/versions": [
        200,
        { ...VERSIONS, versions: [VERSIONS.versions[0]], next_before: 2 },
      ],
      "GET /v1/agents/a-1/versions?before=2": [
        200,
        { current_version: 2, versions: [VERSIONS.versions[1]], next_before: null },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Load older versions" }));
    await screen.findByRole("button", { name: "Restore version 1" });
    expect(calls.some((c) => c.url.endsWith("before=2"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Load older versions" })).toBeNull();
  });
});

describe("Agent builder: model picker", () => {
  it("offers the team's enabled models and the team default, and saves the choice", async () => {
    const calls = stubApi({
      ...READ,
      "POST /v1/agents": [201, { agent: { ...AGENT, id: "a-9" } }],
    });
    renderTeam(<AgentBuilderPage />);
    const select = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect([...select.options].map((o) => o.text)).toEqual([
      "None (use team default)",
      "fast",
      "Smart",
    ]);
    await userEvent.selectOptions(select, "smart");
    await userEvent.type(screen.getByLabelText("Name"), "Triage");
    await userEvent.type(screen.getByLabelText("System prompt"), "Hi");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body)).frontmatter.model).toBe("smart");
  });

  it("keeps a stored model that is no longer enabled", async () => {
    stubApi({
      ...READ,
      "GET /v1/agents/a-1": [
        200,
        { agent: { ...AGENT, frontmatter: { name: "Triage", model: "local" } } },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const select = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("local"));
    expect(select.selectedOptions[0]?.text).toBe("local (not enabled)");
  });
});

describe("Agent builder: Export to Orbit (KOBE-91)", () => {
  const YAML = "# Note: MCP tools are not included\nname: kobe-triage-v2\n";
  const ORBIT_URL = "/v1/agents/a-1/versions/2/orbit";

  /** Routes the orbit URL to a raw YAML answer and everything else to `stubApi`. */
  function stubOrbit(reply: Response) {
    const calls = stubApi(READ);
    const api = globalThis.fetch;
    const fetchOrbit = vi.fn(async (url: string, init?: RequestInit) =>
      url === ORBIT_URL ? reply.clone() : api(url, init),
    );
    vi.stubGlobal("fetch", fetchOrbit);
    return { calls, fetchOrbit };
  }

  function stubDownload() {
    const create = vi.fn((_blob: Blob) => "blob:orbit");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    return { create, click };
  }

  it("downloads the current version as YAML from the toolbar", async () => {
    const { fetchOrbit } = stubOrbit(
      new Response(YAML, { status: 200, headers: { "content-type": "application/yaml" } }),
    );
    const { create, click } = stubDownload();
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Export to Orbit" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(fetchOrbit.mock.calls.some(([url]) => url === ORBIT_URL)).toBe(true);
    expect(await must(create.mock.calls[0])[0].text()).toBe(YAML);
  });

  it("exports an older version from the history", async () => {
    const { fetchOrbit } = stubOrbit(new Response(YAML, { status: 200 }));
    stubDownload();
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const history = await screen.findByRole("region", { name: "Version history" });
    await userEvent.click(
      await within(history).findByRole("button", { name: "Export version 1 to Orbit" }),
    );
    await waitFor(() =>
      expect(fetchOrbit.mock.calls.some(([url]) => url === "/v1/agents/a-1/versions/1/orbit")).toBe(
        true,
      ),
    );
  });

  it("shows the server's reason and downloads nothing when the model can't be resolved", async () => {
    stubOrbit(
      new Response(
        JSON.stringify({ code: "model_not_resolvable", message: "Model smart is not enabled." }),
        { status: 409 },
      ),
    );
    const { click } = stubDownload();
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Export to Orbit" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not enabled/);
    expect(click).not.toHaveBeenCalled();
  });

  it("shows the toolbar button and a button per version only when canExport allows it", async () => {
    stubApi(READ);
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const history = await screen.findByRole("region", { name: "Version history" });
    expect(await screen.findByRole("button", { name: "Export to Orbit" })).toBeTruthy();
    expect(
      await within(history).findAllByRole("button", { name: /^Export version \d to Orbit$/ }),
    ).toHaveLength(2);
  });

  it("hides every export button without canExport, even for an editor and publisher", async () => {
    stubApi({
      ...READ,
      "GET /v1/agents/a-1": [200, { agent: { ...AGENT, canExport: false } }],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const history = await screen.findByRole("region", { name: "Version history" });
    await within(history).findAllByRole("row");
    expect(screen.queryByRole("button", { name: /Orbit/ })).toBeNull();
    // The other actions are unaffected by the export flag.
    expect(within(history).getByRole("button", { name: "Restore version 1" })).toBeTruthy();
  });

  it("hides export when the server sends no canExport flag at all", async () => {
    const { canExport: _omit, ...legacy } = AGENT;
    stubApi({ ...READ, "GET /v1/agents/a-1": [200, { agent: legacy }] });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    const history = await screen.findByRole("region", { name: "Version history" });
    await within(history).findAllByRole("row");
    expect(screen.queryByRole("button", { name: /Orbit/ })).toBeNull();
  });

  it("offers no export for an agent that was never published", async () => {
    stubApi({
      ...READ,
      "GET /v1/agents/a-1": [200, { agent: { ...AGENT, currentVersion: null } }],
      "GET /v1/agents/a-1/versions": [
        200,
        { current_version: null, versions: [], next_before: null },
      ],
    });
    renderTeam(<AgentBuilderPage agentId="a-1" />);
    await screen.findByText("Never published.");
    expect(screen.queryByRole("button", { name: /Export .*Orbit/ })).toBeNull();
  });
});
