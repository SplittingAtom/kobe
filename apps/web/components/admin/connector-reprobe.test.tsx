// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsPage } from "./site/connectors-page";
import { forbidNativeConfirm, renderSite, stubApi } from "./testing";

/** KOBE-430: the Re-probe button on the site connector registry. */
const BASE = "/v1/site/connectors";
const connector = (over: Record<string, unknown> = {}) => ({
  id: "c-1",
  name: "catalyst",
  url: "https://catalyst.example/mcp/",
  iconUrl: null,
  authKind: "api_key",
  status: "active",
  toolCount: 2,
  driftedCount: 0,
  credentialSource: "member",
  siteKeyHint: null,
  siteKeyStale: false,
  refreshSkipped: null,
  refreshedAt: null,
  createdAt: "2026-10-05T10:00:00.000Z",
  updatedAt: "2026-10-05T10:00:00.000Z",
  ...over,
});
const drifted = connector({ toolCount: 3, driftedCount: 2 });
const tools = [
  {
    name: "query",
    status: "drifted",
    change: "changed",
    approved: { description: "reads", inputSchema: {} },
    live: { description: "reads and writes", inputSchema: {}, sha256: "a".repeat(64) },
  },
  {
    name: "export",
    status: "drifted",
    change: "added",
    live: { description: "new", inputSchema: {}, sha256: "b".repeat(64) },
  },
];

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Re-probe (KOBE-430)", () => {
  it("probes now, says what changed, reloads and opens the re-approval review", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [
        [200, { connectors: [connector()] }],
        [200, { connectors: [drifted] }],
      ],
      [`POST ${BASE}/c-1/refresh`]: [
        200,
        {
          connector: drifted,
          refresh: {
            status: "drifted",
            changed: 1,
            added: 1,
            removed: 0,
            templates: { changed: 0, added: 0, removed: 0, invalid: 0 },
            message: "1 changed, 1 added, 0 removed. Review them to offer them again.",
          },
        },
      ],
      [`GET ${BASE}/c-1/tools`]: [200, { tools }],
    });
    renderSite(<ConnectorsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Re-probe catalyst" }));
    expect(
      await screen.findByText("1 changed, 1 added, 0 removed. Review them to offer them again."),
    ).toBeTruthy();
    expect(await screen.findByText(/2 awaiting approval/)).toBeTruthy();
    const article = await screen.findByRole("article", { name: "query" });
    expect(within(article).getByText("reads and writes")).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `${BASE}/c-1/refresh`,
    ]);
  });

  it("says when nothing changed", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector()] }],
      [`POST ${BASE}/c-1/refresh`]: [
        200,
        {
          connector: connector(),
          refresh: { status: "unchanged", message: "No changes: the server lists the same tools." },
        },
      ],
    });
    renderSite(<ConnectorsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Re-probe catalyst" }));
    expect(await screen.findByText("No changes: the server lists the same tools.")).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("shows the failure reason in Kobe's words (a 502 from the remote)", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector()] }],
      [`POST ${BASE}/c-1/refresh`]: [
        502,
        {
          code: "reprobe_failed",
          failure: "auth_required",
          message: "The server asked for credentials. Its tools stay as they were.",
        },
      ],
    });
    renderSite(<ConnectorsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Re-probe catalyst" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /asked for credentials. Its tools stay as they were./,
    );
  });

  it("shows the rate limit and a running refresh", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { connectors: [connector()] }],
      [`POST ${BASE}/c-1/refresh`]: [
        [429, { code: "rate_limited", message: "This connector was re-probed several times." }],
        [409, { code: "refresh_running", message: "Kobe is checking this connector right now." }],
      ],
    });
    renderSite(<ConnectorsPage />);
    const button = await screen.findByRole("button", { name: "Re-probe catalyst" });
    await userEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toMatch(/re-probed several times/);
    await userEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toMatch(/checking this connector/);
  });

  it("is not offered for a disabled connector", async () => {
    stubApi({ [`GET ${BASE}`]: [200, { connectors: [connector({ status: "disabled" })] }] });
    renderSite(<ConnectorsPage />);
    await screen.findByRole("rowheader", { name: "catalyst" });
    expect(screen.queryByRole("button", { name: "Re-probe catalyst" })).toBeNull();
  });
});
