// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsPage } from "./install/connectors-page";
import { renderInstall, stubApi } from "./testing";

const BASE = "/v1/install/connectors";
const connector = (over: Record<string, unknown> = {}) => ({
  id: "c-1",
  name: "github",
  url: "https://mcp.github.example/mcp",
  iconUrl: "https://cdn.example/gh.png",
  authKind: "oauth",
  status: "active",
  toolCount: 0,
  driftedCount: 0,
  createdAt: "2026-10-05T10:00:00.000Z",
  updatedAt: "2026-10-05T10:00:00.000Z",
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

describe("Connector registry (KOBE-100)", () => {
  it("lists connectors with auth, status and icon", async () => {
    stubApi({ [`GET ${BASE}`]: [200, { connectors: [connector()] }] });
    renderInstall(<ConnectorsPage />);
    expect(await screen.findByRole("rowheader", { name: "github" })).toBeTruthy();
    expect(screen.getByText("https://mcp.github.example/mcp")).toBeTruthy();
    const table = within(screen.getByRole("table"));
    expect(table.getByText("OAuth")).toBeTruthy();
    expect(table.getByText("Active")).toBeTruthy();
    expect(document.querySelector("img")?.getAttribute("src")).toBe("https://cdn.example/gh.png");
  });

  it("says when nothing is registered", async () => {
    stubApi({ [`GET ${BASE}`]: [200, { connectors: [] }] });
    renderInstall(<ConnectorsPage />);
    expect(await screen.findByText("No connectors are registered.")).toBeTruthy();
  });

  it("registers a connector and reloads", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [
        [200, { connectors: [] }],
        [200, { connectors: [connector()] }],
      ],
      [`POST ${BASE}`]: [201, { connector: connector() }],
    });
    renderInstall(<ConnectorsPage />);
    await screen.findByText("No connectors are registered.");
    await userEvent.type(screen.getByLabelText("Name"), "github");
    await userEvent.type(screen.getByLabelText("Server URL"), "https://mcp.github.example/mcp");
    await userEvent.type(
      screen.getByLabelText("Icon URL (optional)"),
      "https://cdn.example/gh.png",
    );
    await userEvent.selectOptions(screen.getByLabelText("Authentication"), "oauth");
    await userEvent.click(screen.getByRole("button", { name: "Register connector" }));
    expect(await screen.findByRole("rowheader", { name: "github" })).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({
      name: "github",
      url: "https://mcp.github.example/mcp",
      iconUrl: "https://cdn.example/gh.png",
      authKind: "oauth",
    });
  });

  it("checks the name before sending", async () => {
    const calls = stubApi({ [`GET ${BASE}`]: [200, { connectors: [] }] });
    renderInstall(<ConnectorsPage />);
    await screen.findByText("No connectors are registered.");
    await userEvent.type(screen.getByLabelText("Name"), "Bad Name");
    await userEvent.type(screen.getByLabelText("Server URL"), "https://x.example/mcp");
    await userEvent.click(screen.getByRole("button", { name: "Register connector" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/lowercase/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("shows the server's address-policy refusal", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { connectors: [] }],
      [`POST ${BASE}`]: [
        422,
        {
          code: "address_not_allowed",
          message: "That address is private, link-local or otherwise not allowed for connectors.",
        },
      ],
    });
    renderInstall(<ConnectorsPage />);
    await screen.findByText("No connectors are registered.");
    await userEvent.type(screen.getByLabelText("Name"), "meta");
    await userEvent.type(screen.getByLabelText("Server URL"), "https://169.254.169.254/x");
    await userEvent.click(screen.getByRole("button", { name: "Register connector" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not allowed for connectors/);
  });

  it("edits a connector, sending only what changed", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector()] }],
      [`PATCH ${BASE}/c-1`]: [200, { connector: connector({ authKind: "api_key" }) }],
    });
    renderInstall(<ConnectorsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit github" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("github");
    await userEvent.selectOptions(screen.getByLabelText("Authentication"), "api_key");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(String(patch?.body))).toEqual({ authKind: "api_key" });
  });

  it("disables a connector", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector()] }],
      [`PATCH ${BASE}/c-1`]: [200, { connector: connector({ status: "disabled" }) }],
    });
    renderInstall(<ConnectorsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Disable github" }));
    await screen.findByText("Disabled.");
    expect(JSON.parse(String(calls.find((c) => c.method === "PATCH")?.body))).toEqual({
      status: "disabled",
    });
  });

  it("removes after confirming and shows the server's message about teams", async () => {
    const message =
      "Removed from the registry. 2 teams had it enabled, so it is kept disabled: it is offered to no team and its calls are refused.";
    stubApi({
      [`GET ${BASE}`]: [
        [200, { connectors: [connector()] }],
        [200, { connectors: [] }],
      ],
      [`DELETE ${BASE}/c-1`]: [200, { removed: true, soft: true, teams: 2, message }],
    });
    renderInstall(<ConnectorsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove github" }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByText("No connectors are registered.")).toBeTruthy();
  });

  it("does not remove when the confirmation is declined", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const calls = stubApi({ [`GET ${BASE}`]: [200, { connectors: [connector()] }] });
    renderInstall(<ConnectorsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove github" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("Tool drift re-approval (KOBE-102)", () => {
  const live = (sha256: string, description: string) => ({
    description,
    inputSchema: { type: "object" },
    sha256,
  });
  const tools = [
    {
      name: "ok",
      status: "pinned",
      change: null,
      approved: { description: "fine", inputSchema: {} },
    },
    {
      name: "changed_tool",
      status: "drifted",
      change: "changed",
      approved: { description: "reads issues", inputSchema: { type: "object" } },
      live: live("a".repeat(64), "reads issues and sends them elsewhere"),
    },
    {
      name: "fresh_tool",
      status: "drifted",
      change: "added",
      live: live("b".repeat(64), "brand new"),
    },
  ];
  const routes = (approved: string[]) => ({
    [`GET ${BASE}`]: [200, { connectors: [connector({ toolCount: 3, driftedCount: 2 })] }] as const,
    [`GET ${BASE}/c-1/tools`]: [200, { tools }] as const,
    [`POST ${BASE}/c-1/tools/approve`]: [200, { approved }] as const,
  });

  it("shows old and new definitions and approves one tool with the reviewed hash", async () => {
    const calls = stubApi(routes(["changed_tool"]));
    renderInstall(<ConnectorsPage />);
    await screen.findByText(/2 awaiting approval/);
    await userEvent.click(screen.getByRole("button", { name: /Review/ }));
    const article = await screen.findByRole("article", { name: "changed_tool" });
    expect(within(article).getByText("reads issues")).toBeTruthy();
    expect(within(article).getByText("reads issues and sends them elsewhere")).toBeTruthy();
    await userEvent.click(within(article).getByRole("button", { name: /Approve/ }));
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({
      tools: [{ name: "changed_tool", sha256: "a".repeat(64) }],
    });
  });

  it("approves all pending tools at once", async () => {
    const calls = stubApi(routes(["changed_tool", "fresh_tool"]));
    renderInstall(<ConnectorsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Review/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve all 2" }));
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body)).tools.map((t: { name: string }) => t.name)).toEqual([
      "changed_tool",
      "fresh_tool",
    ]);
  });
});
