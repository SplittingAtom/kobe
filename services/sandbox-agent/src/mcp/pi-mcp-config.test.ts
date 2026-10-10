import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunMcpContext } from "@kobe/protocol";
import {
  buildPiMcpConfig,
  MCP_CONFIG_FILE,
  MCP_TOKEN_FILE,
  mcpTokenFileText,
  verifyAgentFile,
  writeAgentFile,
} from "./pi-mcp-config.js";

const TOKEN = "session-token-for-mcp-proxy-0123456789";
const TOKEN_2 = "rotated-token-for-mcp-proxy-9876543210";
const PROXY = "http://mcp-proxy.kobe.internal:80";
const TOKEN_FILE = "/run/pi-abc123/agent/mcp-token";
const THREAD = "33333333-3333-4333-8333-333333333333";
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
  const text = buildPiMcpConfig({ proxyUrl: PROXY, tokenFile: TOKEN_FILE, threadId: THREAD, mcp });
  const config = JSON.parse(text) as { mcpServers: Record<string, Record<string, unknown>> };

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

  it("ac-2: holds no credential at all; the header is a fixed command naming the token file", () => {
    for (const server of Object.values(config.mcpServers)) {
      expect(Object.keys(server).sort()).toEqual(["exposure", "headers", "toolExposure", "url"]);
      expect(server.headers).toEqual({
        Authorization: `!cat '${TOKEN_FILE}'`,
        "Kobe-Thread-Id": THREAD,
      });
    }
    const urls = strings(config).filter((s) => /^[a-z]+:\/\//.test(s));
    expect(urls.every((u) => u.startsWith(`${PROXY}/v1/mcp/`))).toBe(true);
    expect(text).not.toMatch(/api[_-]?key|secret|password|oauth|Bearer/i);
  });

  it("KOBE-244: every server carries the run's thread, which mcp-proxy requires; ids a header or shell could misread are refused", () => {
    for (const server of Object.values(config.mcpServers)) {
      expect((server.headers as Record<string, string>)["Kobe-Thread-Id"]).toBe(THREAD);
    }
    for (const bad of ["", "a b", "a\nb", "x".repeat(65), "a;b"]) {
      expect(() =>
        buildPiMcpConfig({ proxyUrl: PROXY, tokenFile: TOKEN_FILE, threadId: bad, mcp }),
      ).toThrow();
    }
  });

  it("refuses a token file path a shell would interpret", () => {
    for (const bad of ["rel/path", "/a b", "/a'b", "/a;rm", "/a$(x)", "/a`x`", ""]) {
      expect(() =>
        buildPiMcpConfig({ proxyUrl: PROXY, tokenFile: bad, threadId: THREAD, mcp }),
      ).toThrow();
    }
  });

  it("no connectors: an empty server list", () => {
    const empty = JSON.parse(
      buildPiMcpConfig({
        proxyUrl: PROXY,
        tokenFile: TOKEN_FILE,
        threadId: THREAD,
        mcp: { servers: [] },
      }),
    );
    expect(empty).toEqual({ mcpServers: {}, autoEnableCodemode: false });
  });
});

describe("the token file and rotation", () => {
  it("KOBE-244: explicit modes despite the agent's umask 077 (Pi's group reads, others nothing)", async () => {
    const f = await fixture();
    const previous = process.umask(0o077);
    try {
      for (const name of [MCP_CONFIG_FILE, MCP_TOKEN_FILE]) {
        await writeAgentFile(f.dir, name, "{}\n", true);
        expect((await stat(path.join(f.dir, name))).mode & 0o777).toBe(0o440);
        // A rewrite (token rotation) over a leftover temp file of another mode keeps the mode exact.
        await writeFile(path.join(f.dir, `${name}.tmp`), "old", { mode: 0o666 });
        await writeAgentFile(f.dir, name, "{}\n", true);
        expect((await stat(path.join(f.dir, name))).mode & 0o777).toBe(0o440);
        await writeAgentFile(f.dir, name, "{}\n", false);
        expect((await stat(path.join(f.dir, name))).mode & 0o777).toBe(0o400);
      }
      await expect(readdir(f.dir)).resolves.not.toContain(`${MCP_TOKEN_FILE}.tmp`);
    } finally {
      process.umask(previous);
      await f.done();
    }
  });

  const fixture = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcp-cfg-"));
    return { dir, done: () => rm(dir, { recursive: true, force: true }) };
  };
  // What Pi does with a `!command` header value: run it in a shell, trim the output.
  const resolveHeader = (value: string) =>
    execFileSync("/bin/sh", ["-c", value.slice(1)], { encoding: "utf8" }).trim();

  it("holds only the bearer value, 0400, written atomically", async () => {
    const f = await fixture();
    try {
      await writeAgentFile(f.dir, MCP_TOKEN_FILE, mcpTokenFileText(TOKEN), false);
      expect((await stat(path.join(f.dir, MCP_TOKEN_FILE))).mode & 0o777).toBe(0o400);
      expect(mcpTokenFileText(TOKEN)).toBe(`Bearer ${TOKEN}\n`);
    } finally {
      await f.done();
    }
  });

  it("a rotation mid-run: the next time Pi opens a connection its header is the new token", async () => {
    const f = await fixture();
    try {
      const file = path.join(f.dir, MCP_TOKEN_FILE);
      const header = JSON.parse(
        buildPiMcpConfig({ proxyUrl: PROXY, tokenFile: file, threadId: THREAD, mcp }),
      ).mcpServers.jira.headers.Authorization as string;
      await writeAgentFile(f.dir, MCP_TOKEN_FILE, mcpTokenFileText(TOKEN), false);
      expect(resolveHeader(header)).toBe(`Bearer ${TOKEN}`);
      await writeAgentFile(f.dir, MCP_TOKEN_FILE, mcpTokenFileText(TOKEN_2), false);
      expect(resolveHeader(header)).toBe(`Bearer ${TOKEN_2}`);
    } finally {
      await f.done();
    }
  });

  it("the tripwire notices other content or a link", async () => {
    const f = await fixture();
    try {
      const text = buildPiMcpConfig({
        proxyUrl: PROXY,
        tokenFile: TOKEN_FILE,
        threadId: THREAD,
        mcp,
      });
      await writeAgentFile(f.dir, MCP_CONFIG_FILE, text, false);
      expect(await verifyAgentFile(f.dir, MCP_CONFIG_FILE, [text])).toBe(true);
      expect(await verifyAgentFile(f.dir, MCP_CONFIG_FILE, ["other"])).toBe(false);
      await unlink(path.join(f.dir, MCP_CONFIG_FILE));
      await writeFile(path.join(f.dir, "evil.json"), "{}");
      await symlink(path.join(f.dir, "evil.json"), path.join(f.dir, MCP_CONFIG_FILE));
      expect(await verifyAgentFile(f.dir, MCP_CONFIG_FILE, ["{}"])).toBe(false);
    } finally {
      await f.done();
    }
  });
});
