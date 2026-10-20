import { describe, expect, it } from "vitest";
import type { PinnedTool } from "@kobe/db";
import type { TeamConnector } from "../mcp/catalog.js";
import { pinnedTool } from "../testing/mcp-fixtures.js";
import {
  buildRunMcp,
  connectedConnectorNames,
  type GrantFact,
  type RunConnectorRow,
} from "./run-mcp.js";

const NOW = new Date("2026-10-10T12:00:00Z");
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function connector(
  id: string,
  name: string,
  authKind: TeamConnector["authKind"],
  tools: PinnedTool[] = [],
  exposure: TeamConnector["exposure"] = "all",
  credentialSource: RunConnectorRow["credentialSource"] = "member",
): RunConnectorRow {
  return {
    id,
    name,
    url: "https://up.example/mcp",
    authKind,
    credentialSource,
    exposure,
    enabledTools: [],
    tools,
  };
}

const grant = (connectorId: string, kind: GrantFact["kind"], expiresAt: Date | null = null) => ({
  connectorId,
  kind,
  expiresAt,
});

describe("connectedConnectorNames (the user-connected stub, KOBE-111)", () => {
  const jira = connector(ID_A, "jira", "api_key");
  const gh = connector(ID_B, "git-hub", "oauth");
  const open = connector("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "docs", "none");

  it("needs a grant of the connector's kind; `none` connectors need none", () => {
    expect(connectedConnectorNames([jira, gh, open], [], NOW)).toEqual(["docs"]);
    expect(
      connectedConnectorNames(
        [jira, gh, open],
        [grant(ID_A, "api_key"), grant(ID_B, "oauth")],
        NOW,
      ),
    ).toEqual(["jira", "git-hub", "docs"]);
  });

  it("drops an expired OAuth grant, keeps an unexpired one and an API key", () => {
    const past = new Date(NOW.getTime() - 1000);
    const future = new Date(NOW.getTime() + 60_000);
    expect(connectedConnectorNames([gh], [grant(ID_B, "oauth", past)], NOW)).toEqual([]);
    expect(connectedConnectorNames([gh], [grant(ID_B, "oauth", NOW)], NOW)).toEqual([]);
    expect(connectedConnectorNames([gh], [grant(ID_B, "oauth", future)], NOW)).toEqual(["git-hub"]);
  });

  it("ignores a grant whose kind no longer matches the connector", () => {
    expect(connectedConnectorNames([jira], [grant(ID_A, "oauth")], NOW)).toEqual([]);
  });
});

describe("connectedConnectorNames with a site-wide key (KOBE-303, KOBE-449)", () => {
  const site = connector(ID_A, "catalyst", "api_key", [], "all", "site");
  const own = connector(ID_B, "jira", "api_key");

  it("a site connector with a usable site key is connected for a member without a grant", () => {
    expect(connectedConnectorNames([site, own], [], NOW, new Set([ID_A]))).toEqual(["catalyst"]);
  });

  it("a stale or removed site key does not count, not even with a leftover member grant", () => {
    expect(connectedConnectorNames([site], [], NOW, new Set())).toEqual([]);
    expect(connectedConnectorNames([site], [grant(ID_A, "api_key")], NOW, new Set())).toEqual([]);
  });

  it("no site keys given (a skill eval): the site connector is not connected", () => {
    expect(connectedConnectorNames([site], [], NOW)).toEqual([]);
  });

  it("a member-key connector still needs the member's own grant", () => {
    expect(connectedConnectorNames([own], [], NOW, new Set([ID_B]))).toEqual([]);
  });
});

describe("buildRunMcp", () => {
  const tools = [
    pinnedTool("jira", { name: "get_issue", readOnly: true }),
    pinnedTool("jira", { name: "create_issue", destructive: false }),
    pinnedTool("jira", { name: "drifted", readOnly: true, status: "drifted" }),
  ];
  const jira = connector(ID_A, "jira", "api_key", tools);
  const names = (r: ReturnType<typeof buildRunMcp>) =>
    r.servers.flatMap((s) => s.tools.map((t) => t.pi_name));

  it("lists exactly the effective connectors and their exposed, pinned tools", () => {
    const out = buildRunMcp([jira, connector(ID_B, "other", "none")], ["jira"], undefined);
    expect(out.servers.map((s) => s.name)).toEqual(["jira"]);
    expect(out.servers[0]?.connector_id).toBe(ID_A);
    expect(names(out)).toEqual(["mcp__jira__get_issue", "mcp__jira__create_issue"]);
  });

  it("follows the team's exposure", () => {
    const readOnly = { ...jira, exposure: "read_only" as const };
    expect(names(buildRunMcp([readOnly], ["jira"], undefined))).toEqual(["mcp__jira__get_issue"]);
  });

  it("narrows by the agent's tools.allow and tools.deny globs; deny wins", () => {
    expect(names(buildRunMcp([jira], ["jira"], { allow: ["mcp__jira__get_*"] }))).toEqual([
      "mcp__jira__get_issue",
    ]);
    expect(
      names(buildRunMcp([jira], ["jira"], { allow: ["mcp__jira__*"], deny: ["*create*"] })),
    ).toEqual(["mcp__jira__get_issue"]);
    expect(names(buildRunMcp([jira], ["jira"], { allow: ["read"] }))).toEqual([]);
  });

  it("keeps a connector with no allowed tool out of the list", () => {
    expect(buildRunMcp([jira], ["jira"], { allow: ["read"] }).servers).toEqual([]);
  });
});

describe("app-only tools (KOBE-435 ac-1)", () => {
  it("never offers Pi a tool whose visibility lacks model", () => {
    const tools = [
      pinnedTool("docs", { name: "both", readOnly: true }),
      pinnedTool("docs", { name: "model_only", readOnly: true, ui: { visibility: ["model"] } }),
      pinnedTool("docs", { name: "app_only", readOnly: true, ui: { visibility: ["app"] } }),
      pinnedTool("docs", { name: "nobody", readOnly: true, ui: { visibility: [] } }),
    ];
    const ctx = buildRunMcp([connector(ID_A, "docs", "none", tools)], ["docs"], undefined);
    expect(ctx.servers[0]?.tools.map((t) => t.name)).toEqual(["both", "model_only"]);
  });
});
