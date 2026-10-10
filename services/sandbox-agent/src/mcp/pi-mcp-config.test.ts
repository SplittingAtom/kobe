import { describe, expect, it } from "vitest";
import type { RunMcpContext } from "@kobe/protocol";
import { buildPiMcpConfig, MCP_CONFIG_FILE } from "./pi-mcp-config.js";

const TOKEN = "session-token-for-mcp-proxy-0123456789";
const PROXY = "http://mcp-proxy.kobe.internal:80";
const ID = "11111111-1111-4111-8111-111111111111";
const ID_2 = "22222222-2222-4222-8222-222222222222";
const mcp: RunMcpContext = {
  servers: [
    {
      name: "git-hub",
      connector_id: ID,
      tools: [
        { name: "get_issue", pi_name: "mcp__git_hub__get_issue" },
        { name: "search", pi_name: "mcp__git_hub__search" },
      ],
    },
    { name: "jira", connector_id: ID_2, tools: [{ name: "get", pi_name: "mcp__jira__get" }] },
  ],
};

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("buildPiMcpConfig (KOBE-111)", () => {
  const text = buildPiMcpConfig({ proxyUrl: PROXY, token: TOKEN, mcp });
  const config = JSON.parse(text) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };

  it("names Pi's file mcp.json", () => {
    expect(MCP_CONFIG_FILE).toBe("mcp.json");
  });

  it("lists exactly the effective connectors, each at mcp-proxy's per-connector URL", () => {
    expect(Object.keys(config.mcpServers)).toEqual(["git-hub", "jira"]);
    expect(config.mcpServers["git-hub"]?.url).toBe(`${PROXY}/v1/mcp/${ID}`);
    expect(config.mcpServers.jira?.url).toBe(`${PROXY}/v1/mcp/${ID_2}`);
  });

  it("shows the model exactly the listed tools: the rest of a server stays hidden", () => {
    const server = config.mcpServers["git-hub"];
    expect(server?.exposure).toBe("hidden");
    expect(server?.toolExposure).toEqual({ get_issue: "direct", search: "direct" });
  });

  it("ac-2: carries no secret but the session token, and no stdio command or OAuth block", () => {
    const all = strings(config);
    expect(all.filter((s) => s.includes(TOKEN))).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    for (const server of Object.values(config.mcpServers)) {
      expect(Object.keys(server).sort()).toEqual(["exposure", "headers", "toolExposure", "url"]);
      expect(server.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    }
    // Every URL is the proxy's; nothing else that looks like an address or credential.
    const urls = all.filter((s) => /^[a-z]+:\/\//.test(s));
    expect(urls.every((u) => u.startsWith(`${PROXY}/v1/mcp/`))).toBe(true);
    expect(text.replace(new RegExp(TOKEN, "g"), "")).not.toMatch(
      /api[_-]?key|secret|password|oauth/i,
    );
  });

  it("no connectors: an empty server list", () => {
    const empty = JSON.parse(
      buildPiMcpConfig({ proxyUrl: PROXY, token: TOKEN, mcp: { servers: [] } }),
    );
    expect(empty).toEqual({ mcpServers: {}, autoEnableCodemode: false });
    expect(config).not.toHaveProperty("autoEnableCodemode", true);
  });
});

describe("mcp.json on disk", () => {
  it("is written 0400 and the tripwire notices any other content or a link", async () => {
    const { mkdtemp, rm, symlink, unlink, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { stat } = await import("node:fs/promises");
    const path = await import("node:path");
    const { verifyMcpConfigFile, writeMcpConfigFile } = await import("./pi-mcp-config.js");
    const dir = await mkdtemp(path.join(tmpdir(), "mcp-cfg-"));
    try {
      const text = buildPiMcpConfig({ proxyUrl: PROXY, token: TOKEN, mcp });
      await writeMcpConfigFile(dir, text, false);
      expect((await stat(path.join(dir, MCP_CONFIG_FILE))).mode & 0o777).toBe(0o400);
      expect(await verifyMcpConfigFile(dir, [text])).toBe(true);
      expect(await verifyMcpConfigFile(dir, ["other"])).toBe(false);
      await unlink(path.join(dir, MCP_CONFIG_FILE));
      await writeFile(path.join(dir, "evil.json"), "{}");
      await symlink(path.join(dir, "evil.json"), path.join(dir, MCP_CONFIG_FILE));
      expect(await verifyMcpConfigFile(dir, ["{}"])).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
