// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsPage } from "./site/connectors-page";
import { forbidNativeConfirm, renderSite, stubApi } from "./testing";

/** Site connector registry: the connector detail panel (KOBE-641). */
const BASE = "/v1/site/connectors";
const connector = (over: Record<string, unknown> = {}) => ({
  id: "c-1",
  name: "catalyst",
  url: "https://catalyst.example/mcp/",
  iconUrl: null,
  authKind: "api_key",
  status: "active",
  toolCount: 3,
  driftedCount: 1,
  templatesCount: 2,
  templatesDriftedCount: 1,
  credentialSource: "site",
  siteKeyHint: "…wxyz",
  siteKeyStale: false,
  refreshSkipped: null,
  refreshedAt: "2026-11-12T09:00:00.000Z",
  createdAt: "2026-10-05T10:00:00.000Z",
  updatedAt: "2026-10-05T10:00:00.000Z",
  ...over,
});
const tools = [
  {
    name: "lake_query",
    status: "pinned",
    change: null,
    approved: {
      description: "Run a SQL query on the lakehouse.",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string" }, limit: { type: "integer" } },
        required: ["sql"],
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ui: { resourceUri: "ui://catalyst/lake-query" },
    },
  },
  {
    name: "drop_table",
    status: "pinned",
    change: null,
    approved: {
      description: "Drop a table.",
      inputSchema: { type: "object", properties: { table: { type: "string" } } },
      annotations: { destructiveHint: true },
    },
  },
  {
    name: "pick_table",
    status: "drifted",
    change: "added",
    live: {
      description: "Pick a table.",
      inputSchema: { type: "object" },
      ui: { resourceUri: "ui://catalyst/picker" },
      sha256: "1".repeat(64),
    },
  },
];
const version = { sha256: "a".repeat(64), pinnedHash: "b".repeat(64), bytes: 10, mimeType: "x" };
const templates = [
  {
    uri: "ui://catalyst/lake-query",
    status: "pinned",
    change: null,
    approved: version,
    placement: "artifacts",
  },
  { uri: "ui://catalyst/picker", status: "drifted", change: "added", live: version },
];
const teams = [
  { id: "t-1", name: "Team1", slug: "team1", exposure: "read_only", enabledTools: 0 },
  { id: "t-2", name: "Ops", slug: "ops", exposure: "custom", enabledTools: 2 },
];
const routes = () => ({
  [`GET ${BASE}`]: [200, { connectors: [connector()] }] as const,
  [`GET ${BASE}/c-1/tools`]: [200, { tools }] as const,
  [`GET ${BASE}/c-1/templates`]: [200, { templates }] as const,
  [`GET ${BASE}/c-1/teams`]: [200, { teams }] as const,
});

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openPanel() {
  renderSite(<ConnectorsPage />);
  const name = await screen.findByRole("button", { name: "catalyst" });
  await userEvent.click(name);
  const panel = await screen.findByRole("dialog", { name: "Connector catalyst" });
  return { name, panel: within(panel), el: panel };
}

describe("connector detail panel (KOBE-641)", () => {
  it("opens from the name and closes with Escape, focus back on the name", async () => {
    stubApi(routes());
    const { name } = await openPanel();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(name);
  });

  it("closes with its Close button too", async () => {
    stubApi(routes());
    const { name, panel } = await openPanel();
    await userEvent.click(panel.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(name);
  });

  it("shows the connector's information, teams and templates, never the site key", async () => {
    stubApi(routes());
    const { panel, el } = await openPanel();
    const info = within(panel.getByRole("region", { name: "About catalyst" }));
    expect(info.getByText("https://catalyst.example/mcp/")).toBeTruthy();
    expect(info.getByText("API key")).toBeTruthy();
    expect(info.getByText(/Site-wide key \(set\)/)).toBeTruthy();
    expect(info.getByText("Active")).toBeTruthy();
    expect(info.getByText("3, 1 awaiting approval")).toBeTruthy();
    expect(info.getByText("2, 1 awaiting approval")).toBeTruthy();
    const teamList = within(await panel.findByRole("region", { name: "Teams using catalyst" }));
    expect(teamList.getByText("Team1")).toBeTruthy();
    expect(teamList.getByText("Read-only tools")).toBeTruthy();
    expect(teamList.getByText(/Chosen tools \(2\)/)).toBeTruthy();
    const apps = within(panel.getByRole("region", { name: "App templates of catalyst" }));
    const lake = within(apps.getByRole("listitem", { name: "ui://catalyst/lake-query" }));
    expect(lake.getByText("Approved")).toBeTruthy();
    expect(lake.getByText(/Artifact column/)).toBeTruthy();
    const picker = within(apps.getByRole("listitem", { name: "ui://catalyst/picker" }));
    expect(picker.getByText("Awaiting review")).toBeTruthy();
    expect(el.textContent).not.toContain("wxyz");
  });

  it("lists every tool by Read only and Write with annotations, inputs and the MCP-UI badge", async () => {
    stubApi(routes());
    const { panel } = await openPanel();
    const readOnly = within(
      await panel.findByRole("region", { name: "Read only tools of catalyst" }),
    );
    const write = within(panel.getByRole("region", { name: "Write tools of catalyst" }));
    const lake = within(readOnly.getByRole("listitem", { name: "lake_query tool" }));
    expect(lake.getByText("Run a SQL query on the lakehouse.")).toBeTruthy();
    expect(lake.getByText("Idempotent")).toBeTruthy();
    expect(lake.getByText("Closed world")).toBeTruthy();
    expect(lake.getByText(/sql \(string, required\)/)).toBeTruthy();
    expect(lake.getByText(/limit \(integer\)/)).toBeTruthy();
    expect(lake.getByTitle("Opens an app: ui://catalyst/lake-query (approved)")).toBeTruthy();
    expect(lake.getByText("Pinned")).toBeTruthy();
    const drop = within(write.getByRole("listitem", { name: "drop_table tool" }));
    expect(drop.getByText("Destructive")).toBeTruthy();
    expect(drop.getByText("Open world")).toBeTruthy();
    expect(drop.queryByText("MCP-UI")).toBeNull();
    const pick = within(write.getByRole("listitem", { name: "pick_table tool" }));
    expect(pick.getByText(/Awaiting approval \(new\)/)).toBeTruthy();
    expect(pick.getByText("No inputs")).toBeTruthy();
    expect(
      pick.getByTitle("Opens an app: ui://catalyst/picker (waiting for a site admin's review)"),
    ).toBeTruthy();
  });

  it("says when a part could not be loaded and keeps the rest", async () => {
    stubApi({ ...routes(), [`GET ${BASE}/c-1/teams`]: [500, { message: "boom" }] as const });
    const { panel } = await openPanel();
    expect(await panel.findByRole("region", { name: "Read only tools of catalyst" })).toBeTruthy();
    expect(
      within(panel.getByRole("region", { name: "Teams using catalyst" })).getByRole("alert"),
    ).toBeTruthy();
  });
});
