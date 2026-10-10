// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderTeam, stubApi } from "../admin/testing";
import { MyConnectorsPage } from "./my-connectors-page";

const TEAM_CONNECTORS = "/v1/team/connectors";
const GRANTS = "/v1/connector-grants";
const MEMBER = { role: "member", permissions: ["team.chat"] } as const;
const KEY = "sk-live-0123456789abcdef";
const connector = (over: Record<string, unknown> = {}) => ({
  id: "c-1",
  name: "jira",
  auth_kind: "api_key",
  status: "active",
  icon_url: null,
  enabled: true,
  exposure: "all",
  enabled_tools: [],
  tools: [],
  ...over,
});
const grant = {
  connector_id: "c-1",
  hint: "…cdef",
  created_at: "2026-10-05T10:00:00Z",
  updated_at: "2026-10-05T10:00:00Z",
};

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

describe("My connector keys (KOBE-105)", () => {
  it("lists only enabled, active api_key connectors", async () => {
    stubApi({
      [`GET ${TEAM_CONNECTORS}`]: [
        200,
        {
          connectors: [
            connector(),
            connector({ id: "c-2", name: "off", enabled: false }),
            connector({ id: "c-3", name: "oauthy", auth_kind: "oauth" }),
            connector({ id: "c-4", name: "gone", status: "disabled" }),
          ],
        },
      ],
      [`GET ${GRANTS}`]: [200, { grants: [] }],
    });
    renderTeam(<MyConnectorsPage />, MEMBER);
    await screen.findByRole("article", { name: "jira" });
    expect(screen.queryByRole("article", { name: "off" })).toBeNull();
    expect(screen.queryByRole("article", { name: "oauthy" })).toBeNull();
    expect(screen.queryByRole("article", { name: "gone" })).toBeNull();
    expect(card("jira").getByText("No key added")).toBeTruthy();
  });

  it("adds a key, clears the field and shows only the hint", async () => {
    const calls = stubApi({
      [`GET ${TEAM_CONNECTORS}`]: [200, { connectors: [connector()] }],
      [`GET ${GRANTS}`]: [
        [200, { grants: [] }],
        [200, { grants: [grant] }],
      ],
      [`PUT ${GRANTS}/c-1`]: [201, { grant }],
    });
    renderTeam(<MyConnectorsPage />, MEMBER);
    await screen.findByRole("article", { name: "jira" });
    const input = card("jira").getByLabelText("API key") as HTMLInputElement;
    expect(input.type).toBe("password");
    await userEvent.type(input, KEY);
    await userEvent.click(card("jira").getByRole("button", { name: "Add key" }));
    expect(await screen.findByText(/Key ending …cdef/)).toBeTruthy();
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({ api_key: KEY });
    expect((card("jira").getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("replaces and removes a key", async () => {
    const calls = stubApi({
      [`GET ${TEAM_CONNECTORS}`]: [200, { connectors: [connector()] }],
      [`GET ${GRANTS}`]: [
        [200, { grants: [grant] }],
        [200, { grants: [grant] }],
        [200, { grants: [] }],
      ],
      [`PUT ${GRANTS}/c-1`]: [200, { grant }],
      [`DELETE ${GRANTS}/c-1`]: [204],
    });
    renderTeam(<MyConnectorsPage />, MEMBER);
    await screen.findByText(/Key ending …cdef/);
    await userEvent.type(card("jira").getByLabelText("API key"), KEY);
    await userEvent.click(card("jira").getByRole("button", { name: "Replace key" }));
    await screen.findByText("Key replaced.");
    await userEvent.click(card("jira").getByRole("button", { name: "Remove key" }));
    expect(await screen.findByText("No key added")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("checks the key length before sending and never echoes it on error", async () => {
    const calls = stubApi({
      [`GET ${TEAM_CONNECTORS}`]: [200, { connectors: [connector()] }],
      [`GET ${GRANTS}`]: [200, { grants: [] }],
      [`PUT ${GRANTS}/c-1`]: [
        503,
        { code: "credentials_unavailable", message: "This install cannot store credentials yet." },
      ],
    });
    renderTeam(<MyConnectorsPage />, MEMBER);
    await screen.findByRole("article", { name: "jira" });
    await userEvent.type(card("jira").getByLabelText("API key"), "short");
    await userEvent.click(card("jira").getByRole("button", { name: "Add key" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await userEvent.clear(card("jira").getByLabelText("API key"));
    await userEvent.type(card("jira").getByLabelText("API key"), KEY);
    await userEvent.click(card("jira").getByRole("button", { name: "Add key" }));
    expect(await screen.findByText(/cannot store credentials/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("says when no connector needs a key", async () => {
    stubApi({
      [`GET ${TEAM_CONNECTORS}`]: [200, { connectors: [] }],
      [`GET ${GRANTS}`]: [200, { grants: [] }],
    });
    renderTeam(<MyConnectorsPage />, MEMBER);
    expect(await screen.findByText(/No connector in this team needs your own key/)).toBeTruthy();
  });
});
