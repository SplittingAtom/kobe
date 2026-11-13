// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamConnectorsPage } from "./team/connectors-page";
import { forbidNativeConfirm, answerConfirm, renderTeam, stubApi } from "./testing";

const BASE = "/v1/team/connectors";
const tool = (name: string, over: Record<string, unknown> = {}) => ({
  pi_name: `jira__${name}`,
  name,
  title: null,
  read_only: false,
  open_world: true,
  status: "pinned",
  app: null,
  ...over,
});
const connector = (over: Record<string, unknown> = {}) => ({
  id: "c-1",
  name: "jira",
  auth_kind: "api_key",
  status: "active",
  icon_url: null,
  enabled: false,
  exposure: null,
  enabled_tools: [],
  tools: [
    tool("get_issue", { read_only: true, open_world: false }),
    tool("create_issue"),
    tool("move_issue", { status: "drifted" }),
  ],
  ...over,
});

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const card = (name: string) => within(screen.getByRole("article", { name }));

describe("Team connectors (KOBE-105)", () => {
  it("lists connectors off by default, with tools labelled by risk", async () => {
    stubApi({ [`GET ${BASE}`]: [200, { connectors: [connector()] }] });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const jira = card("jira");
    expect(jira.getByText("Not enabled")).toBeTruthy();
    const get = jira.getByRole("listitem", { name: "get_issue tool" });
    expect(within(get).getByText("Closed-world")).toBeTruthy();
    const create = jira.getByRole("listitem", { name: "create_issue tool" });
    expect(within(create).getByText("Open-world")).toBeTruthy();
    expect(
      jira.getByText(/doesn.t declare itself read-only is treated as able to change data/i),
    ).toBeTruthy();
  });

  it("splits the tools into Read only and Write columns with counts (KOBE-639)", async () => {
    stubApi({ [`GET ${BASE}`]: [200, { connectors: [connector()] }] });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const jira = card("jira");
    const readOnly = within(jira.getByRole("region", { name: "Read only tools of jira" }));
    const write = within(jira.getByRole("region", { name: "Write tools of jira" }));
    expect(readOnly.getByRole("heading", { name: /Read only.*1/ })).toBeTruthy();
    expect(write.getByRole("heading", { name: /Write.*2/ })).toBeTruthy();
    expect(readOnly.getByRole("listitem", { name: "get_issue tool" })).toBeTruthy();
    // No readOnlyHint (or false) is Write, like exposure read_only on the server.
    expect(write.getByRole("listitem", { name: "create_issue tool" })).toBeTruthy();
    expect(write.getByRole("listitem", { name: "move_issue tool" })).toBeTruthy();
    expect(readOnly.queryByRole("listitem", { name: "create_issue tool" })).toBeNull();
  });

  it("shows a short empty state in a column without tools", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector({ tools: [tool("create_issue")] })] }],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const readOnly = within(card("jira").getByRole("region", { name: "Read only tools of jira" }));
    expect(readOnly.getByText("No read-only tools.")).toBeTruthy();
    expect(readOnly.getByRole("heading", { name: /Read only.*0/ })).toBeTruthy();
  });

  it("marks Write tools as not offered while the saved exposure is Read-only tools", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector({ enabled: true, exposure: "read_only" })] }],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const jira = card("jira");
    const create = jira.getByRole("listitem", { name: "create_issue tool" });
    expect(within(create).getByText("Not offered to the team (Read-only tools)")).toBeTruthy();
    const get = jira.getByRole("listitem", { name: "get_issue tool" });
    expect(within(get).queryByText(/Not offered/)).toBeNull();
    // Choosing All tools without saving changes nothing the team has (review M2).
    await userEvent.click(jira.getByLabelText(/All tools/));
    expect(within(create).getByText("Not offered to the team (Read-only tools)")).toBeTruthy();
  });

  it("says a Write tool would not be offered while Read-only tools is chosen but not saved", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector({ enabled: true, exposure: "all" })] }],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const jira = card("jira");
    const create = jira.getByRole("listitem", { name: "create_issue tool" });
    expect(within(create).queryByText(/offered/)).toBeNull();
    await userEvent.click(jira.getByLabelText(/Read-only tools/));
    expect(within(create).getByText("Would not be offered under Read-only tools")).toBeTruthy();
    expect(within(create).queryByText(/Not offered to the team/)).toBeNull();
  });

  it("marks app-only tools as not offered under every exposure, like the server (review M1)", async () => {
    stubApi({
      [`GET ${BASE}`]: [
        200,
        {
          connectors: [
            connector({
              enabled: true,
              exposure: "all",
              tools: [
                tool("render", { read_only: true, model_visible: false }),
                tool("get_issue", { read_only: true }),
              ],
            }),
          ],
        },
      ],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const jira = card("jira");
    const render = () => within(jira.getByRole("listitem", { name: "render tool" }));
    expect(render().getByText("Not offered (app only)")).toBeTruthy();
    expect(
      within(jira.getByRole("listitem", { name: "get_issue tool" })).queryByText(/Not offered/),
    ).toBeNull();
    await userEvent.click(jira.getByLabelText(/Chosen tools/));
    expect(render().getByText("Not offered (app only)")).toBeTruthy();
    expect((jira.getByLabelText("render") as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(jira.getByLabelText(/Read-only tools/));
    expect(render().getByText("Not offered (app only)")).toBeTruthy();
  });

  it("ticks tools in both columns under Chosen tools", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector()] }],
      [`PUT ${BASE}/c-1`]: [200, { connector: connector({ enabled: true, exposure: "custom" }) }],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const jira = card("jira");
    await userEvent.click(jira.getByLabelText(/Chosen tools/));
    const readOnly = within(jira.getByRole("region", { name: "Read only tools of jira" }));
    const write = within(jira.getByRole("region", { name: "Write tools of jira" }));
    await userEvent.click(readOnly.getByLabelText("get_issue"));
    await userEvent.click(write.getByLabelText("create_issue"));
    await userEvent.click(jira.getByRole("button", { name: /Enable/ }));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({
      exposure: "custom",
      enabled_tools: ["jira__get_issue", "jira__create_issue"],
    });
  });

  it("badges tools that open an MCP-UI app, naming the template and its review (KOBE-640)", async () => {
    stubApi({
      [`GET ${BASE}`]: [
        200,
        {
          connectors: [
            connector({
              tools: [
                tool("explore", {
                  read_only: true,
                  app: { resource_uri: "ui://jira/explorer", review: "approved" },
                }),
                tool("pick", { app: { resource_uri: "ui://jira/picker", review: "pending" } }),
                tool("get_issue", { read_only: true }),
              ],
            }),
          ],
        },
      ],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const jira = card("jira");
    const explore = within(jira.getByRole("listitem", { name: "explore tool" }));
    // A focusable trigger named by the template and its review; its tooltip opens on focus.
    const badge = explore.getByRole("button", {
      name: "MCP-UI: Opens an app: ui://jira/explorer (approved)",
    });
    badge.focus();
    expect(document.activeElement).toBe(badge);
    expect(
      (await screen.findAllByText("Opens an app: ui://jira/explorer (approved)")).length,
    ).toBeGreaterThan(0);
    const pick = within(jira.getByRole("listitem", { name: "pick tool" }));
    expect(
      pick.getByRole("button", {
        name: "MCP-UI: Opens an app: ui://jira/picker (waiting for a site admin's review)",
      }),
    ).toBeTruthy();
    const plain = within(jira.getByRole("listitem", { name: "get_issue tool" }));
    expect(plain.queryByText("MCP-UI")).toBeNull();
  });

  it("shows drifted tools as unavailable", async () => {
    stubApi({ [`GET ${BASE}`]: [200, { connectors: [connector()] }] });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const moved = card("jira").getByRole("listitem", { name: "move_issue tool" });
    expect(within(moved).getByText(/unavailable/i)).toBeTruthy();
  });

  it("enables with an exposure", async () => {
    const enabled = connector({ enabled: true, exposure: "read_only" });
    const calls = stubApi({
      [`GET ${BASE}`]: [
        [200, { connectors: [connector()] }],
        [200, { connectors: [enabled] }],
      ],
      [`PUT ${BASE}/c-1`]: [200, { connector: enabled }],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    await userEvent.click(card("jira").getByLabelText(/Read-only tools/));
    await userEvent.click(card("jira").getByRole("button", { name: /Enable/ }));
    expect(await screen.findByText(/Enabled jira/)).toBeTruthy();
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({ exposure: "read_only" });
    expect(put?.headers.get("X-Kobe-Team")).toBe("t-1");
  });

  it("custom exposure sends the ticked pinned tools, never drifted ones", async () => {
    const enabled = connector({
      enabled: true,
      exposure: "custom",
      enabled_tools: ["jira__create_issue"],
    });
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector()] }],
      [`PUT ${BASE}/c-1`]: [200, { connector: enabled }],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const jira = card("jira");
    await userEvent.click(jira.getByLabelText(/Chosen tools/));
    expect((jira.getByLabelText("move_issue") as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(jira.getByLabelText("create_issue"));
    await userEvent.click(jira.getByRole("button", { name: /Enable/ }));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({
      exposure: "custom",
      enabled_tools: ["jira__create_issue"],
    });
  });

  it("prefills an enabled connector and drops ticks for tools that drifted", async () => {
    stubApi({
      [`GET ${BASE}`]: [
        200,
        {
          connectors: [
            connector({
              enabled: true,
              exposure: "custom",
              enabled_tools: ["jira__create_issue", "jira__move_issue"],
            }),
          ],
        },
      ],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const jira = card("jira");
    expect((jira.getByLabelText(/Chosen tools/) as HTMLInputElement).checked).toBe(true);
    expect((jira.getByLabelText("create_issue") as HTMLInputElement).checked).toBe(true);
    expect((jira.getByLabelText("move_issue") as HTMLInputElement).checked).toBe(false);
  });

  it("disables after confirming", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [
        [200, { connectors: [connector({ enabled: true, exposure: "all" })] }],
        [200, { connectors: [connector()] }],
      ],
      [`DELETE ${BASE}/c-1`]: [204],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    await userEvent.click(card("jira").getByRole("button", { name: /Disable/ }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await answerConfirm("Disable jira for the team?", "Disable jira");
    expect(await screen.findByText("Not enabled")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("cannot enable a connector the site admin disabled", async () => {
    stubApi({ [`GET ${BASE}`]: [200, { connectors: [connector({ status: "disabled" })] }] });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    expect(card("jira").getByText(/disabled by a site admin/i)).toBeTruthy();
    expect(card("jira").queryByRole("button", { name: /Enable/ })).toBeNull();
  });

  it("shows the server's refusal", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector()] }],
      [`PUT ${BASE}/c-1`]: [
        422,
        { code: "unknown_tool", message: "Pick only tools the connector lists." },
      ],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    await userEvent.click(card("jira").getByLabelText(/All tools/));
    await userEvent.click(card("jira").getByRole("button", { name: /Enable/ }));
    expect(await screen.findByText(/Pick only tools/)).toBeTruthy();
  });

  it("says when nothing is registered", async () => {
    stubApi({ [`GET ${BASE}`]: [200, { connectors: [] }] });
    renderTeam(<TeamConnectorsPage />);
    expect(await screen.findByText(/No connectors are registered/)).toBeTruthy();
  });
});

describe("the built-in Kobe connector (KOBE-623)", () => {
  const kobe = (over: Record<string, unknown> = {}) => ({
    connector_id: "6b6f6265-0000-4000-8000-000000000001",
    name: "kobe",
    mode: "admin",
    level: "docs",
    docs_tools: ["mcp__kobe__docs_index"],
    admin_tools: [],
    ...over,
  });

  it("shows its three levels (docs only by default) and saves one with the level seen", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { connectors: [] }],
      [`GET ${BASE}/kobe`]: [
        [200, { kobe: kobe() }],
        [200, { kobe: kobe({ level: "read_write" }) }],
      ],
      [`PUT ${BASE}/kobe`]: [200, { kobe: kobe({ level: "read_write" }) }],
    });
    renderTeam(<TeamConnectorsPage />, { permissions: ["team.read", "team.connectors.manage"] });
    const k = within(await screen.findByRole("article", { name: "Kobe" }));
    const docs = k.getByRole("radio", { name: "Docs only" }) as HTMLInputElement;
    expect(docs.checked).toBe(true);
    expect(k.getByRole("radio", { name: "Read" })).toBeTruthy();
    expect((k.getByRole("button", { name: /Save level/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(k.getByRole("radio", { name: "Read and write" }));
    await userEvent.click(k.getByRole("button", { name: /Save level/ }));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({ level: "read_write", expected_level: "docs" });
    await screen.findByText("Kobe connector: Read and write.");
    expect(
      (
        within(screen.getByRole("article", { name: "Kobe" })).getByRole("radio", {
          name: "Read and write",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("is read-only without team.connectors.manage and says when the site limits it", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { connectors: [] }],
      [`GET ${BASE}/kobe`]: [200, { kobe: kobe({ mode: "docs", level: "read" }) }],
    });
    renderTeam(<TeamConnectorsPage />, { role: "member", permissions: ["team.read"] });
    const k = within(await screen.findByRole("article", { name: "Kobe" }));
    expect((k.getByRole("radio", { name: "Read" }) as HTMLInputElement).disabled).toBe(true);
    expect(k.queryByRole("button", { name: /Save level/ })).toBeNull();
    expect(k.getByText(/limited Kobe to its docs tools/)).toBeTruthy();
  });

  it("is not shown while the site switch is off", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector()] }],
      [`GET ${BASE}/kobe`]: [200, { kobe: kobe({ mode: "off" }) }],
    });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    expect(screen.queryByRole("article", { name: "Kobe" })).toBeNull();
  });
});
