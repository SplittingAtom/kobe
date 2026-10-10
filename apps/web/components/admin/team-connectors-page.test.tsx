// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamConnectorsPage } from "./team/connectors-page";
import { renderTeam, stubApi } from "./testing";

const BASE = "/v1/team/connectors";
const tool = (name: string, over: Record<string, unknown> = {}) => ({
  pi_name: `jira__${name}`,
  name,
  title: null,
  read_only: false,
  open_world: true,
  status: "pinned",
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

const card = (name: string) => within(screen.getByRole("article", { name }));

describe("Team connectors (KOBE-105)", () => {
  it("lists connectors off by default, with tools labelled by risk", async () => {
    stubApi({ [`GET ${BASE}`]: [200, { connectors: [connector()] }] });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    const jira = card("jira");
    expect(jira.getByText("Not enabled")).toBeTruthy();
    const get = jira.getByRole("listitem", { name: "get_issue tool" });
    expect(within(get).getByText("Read-only")).toBeTruthy();
    expect(within(get).getByText("Closed-world")).toBeTruthy();
    const create = jira.getByRole("listitem", { name: "create_issue tool" });
    expect(within(create).getByText("Write")).toBeTruthy();
    expect(within(create).getByText("Open-world")).toBeTruthy();
    expect(jira.getByText(/unannotated tools count as write and open-world/i)).toBeTruthy();
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
    expect(await screen.findByText("Not enabled")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("cannot enable a connector the install admin disabled", async () => {
    stubApi({ [`GET ${BASE}`]: [200, { connectors: [connector({ status: "disabled" })] }] });
    renderTeam(<TeamConnectorsPage />);
    await screen.findByRole("article", { name: "jira" });
    expect(card("jira").getByText(/disabled by an install admin/i)).toBeTruthy();
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
