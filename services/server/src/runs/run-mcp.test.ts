import { describe, expect, it } from "vitest";
import type { PinnedTool } from "@kobe/db";
import type { TeamConnector } from "../mcp/catalog.js";
import { pinnedTool } from "../testing/mcp-fixtures.js";
import { buildRunMcp, connectedConnectorNames, type GrantFact } from "./run-mcp.js";

const NOW = new Date("2026-10-10T12:00:00Z");
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function connector(
  id: string,
  name: string,
  authKind: TeamConnector["authKind"],
  tools: PinnedTool[] = [],
  exposure: TeamConnector["exposure"] = "all",
): TeamConnector {
  return { id, name, url: "https://up.example/mcp", authKind, exposure, enabledTools: [], tools };
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
      connectedConnectorNames([jira, gh, open], [grant(ID_A, "api_key"), grant(ID_B, "oauth")], NOW),
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

describe("buildRunMcp", () => {
  const tools = [
    pinnedTool("jira", { name: "get_issue", readOnly: true }),
    pinnedTool("jira", { name: "create_issue", destructive: false }),
    pinnedTool("jira", { name: "drifted", readOnly: true, status: "drifted" }),
  ];
  const jira = connector(ID_A, "jira", "api_key", tools);
  const names = (r: ReturnType<typeof buildRunMcp>) => r.servers.flatMap((s) => s.tools.map((t) => t.pi_name));

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
    expect(names(buildRunMcp([jira], ["jira"], { allow: ["mcp__jira__*"], deny: ["*create*"] }))).toEqual([
      "mcp__jira__get_issue",
    ]);
    expect(names(buildRunMcp([jira], ["jira"], { allow: ["read"] }))).toEqual([]);
  });

  it("keeps a connector with no allowed tool out of the list", () => {
    expect(buildRunMcp([jira], ["jira"], { allow: ["read"] }).servers).toEqual([]);
  });
});
