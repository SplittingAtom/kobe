import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelTokenSource } from "./models/types.js";
import {
  RUN_2,
  runStart,
  startHarness,
  until,
  FAKE_POLICY_EXTENSION,
  type Harness,
} from "./testing/harness.js";

/**
 * Per-session MCP config for Pi (KOBE-111) with the scripted Pi: the capability, `mcp.json` in the
 * thread's private config dir (never the workspace), the session token as its only credential,
 * its rotation, and that a run without connectors gets no MCP extension.
 */
const PROXY = "http://mcp-proxy.kobe.internal:80";
const TOKEN_1 = "mcp-token-one-".padEnd(40, "1");
const TOKEN_2 = "mcp-token-two-".padEnd(40, "2");
const ID = "11111111-1111-4111-8111-111111111111";
const MCP = {
  servers: [
    {
      name: "jira",
      connector_id: ID,
      tools: [{ name: "get_issue", pi_name: "mcp__jira__get_issue" }],
    },
  ],
};

function fakeTokens(initial: string) {
  let current = initial;
  const listeners = new Set<(token: string) => void>();
  const source: ModelTokenSource & { rotate(token: string): void } = {
    current: async () => current,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rotate(token) {
      current = token;
      for (const l of listeners) l(token);
    },
  };
  return source;
}

let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

async function launchRecord() {
  const [launch] = await h.commandsLog();
  return launch as { argv: string[]; agentDir: string };
}

describe("per-session MCP config (KOBE-111)", () => {
  it("announces the capability only with proxy wiring", async () => {
    h = await startHarness({ mcp: { proxyUrl: PROXY, tokens: fakeTokens(TOKEN_1) } });
    expect(h.server.frames("hello").at(-1)?.capabilities).toContain("mcp");
    await h.close();
    h = await startHarness();
    expect(h.server.frames("hello").at(-1)?.capabilities ?? []).not.toContain("mcp");
  });

  it("ac-1/ac-2: writes mcp.json into the private config dir with only the session token", async () => {
    const tokens = fakeTokens(TOKEN_1);
    h = await startHarness({ mcp: { proxyUrl: PROXY, tokens } });
    const started = await h.server.command(runStart("hang", { mcp: MCP }));
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    const launch = await launchRecord();
    const extensions = launch.argv.flatMap((a, i) =>
      a === "--extension" ? [launch.argv[i + 1]] : [],
    );
    expect(extensions).toEqual(["builtin:mcp", FAKE_POLICY_EXTENSION]);
    const file = path.join(launch.agentDir, "mcp.json");
    const tokenFile = path.join(launch.agentDir, "mcp-token");
    expect(file.startsWith(path.join(h.dir, "pi-runtime"))).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o400);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o400);
    const text = await readFile(file, "utf8");
    expect(JSON.parse(text).mcpServers.jira).toMatchObject({
      url: `${PROXY}/v1/mcp/${ID}`,
      headers: { Authorization: `!cat '${tokenFile}'` },
    });
    expect(text).not.toContain(TOKEN_1);
    expect(await readFile(tokenFile, "utf8")).toBe(`Bearer ${TOKEN_1}\n`);
    // Nothing under the workspace names the connector config.
    expect(existsSync(path.join(h.dir, "workspace", "mcp.json"))).toBe(false);

    // Rotation mid-run: only the token file changes; mcp.json and the tripwire stay as they are.
    tokens.rotate(TOKEN_2);
    await until(async () => (await readFile(tokenFile, "utf8")).includes(TOKEN_2));
    expect(await readFile(file, "utf8")).toBe(text);
    expect(await readFile(tokenFile, "utf8")).not.toContain(TOKEN_1);
  });

  it("a run with no effective connector starts Pi without the MCP extension or file", async () => {
    h = await startHarness({ mcp: { proxyUrl: PROXY, tokens: fakeTokens(TOKEN_1) } });
    expect(await h.server.command(runStart("hang", { mcp: { servers: [] } }))).toMatchObject({
      ok: true,
    });
    const launch = await launchRecord();
    expect(launch.argv).not.toContain("builtin:mcp");
    expect(existsSync(path.join(launch.agentDir, "mcp.json"))).toBe(false);
  });

  it("fails the run when it lists connectors but the sandbox has no proxy access", async () => {
    h = await startHarness();
    const result = await h.server.command(runStart("hang", { mcp: MCP }));
    expect(result).toMatchObject({ ok: false, error: { code: "pi_unavailable" } });
  });
});

describe("connector changes on the next run of the same thread (KOBE-112 ac-1)", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const SECOND = {
    servers: [
      {
        name: "wiki",
        connector_id: OTHER,
        tools: [{ name: "search", pi_name: "mcp__wiki__search" }],
      },
    ],
  };

  async function settledRun(run: ReturnType<typeof runStart>) {
    const result = await h.server.command(run);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await h.server.waitFor(
      (f) => f.type === "pi.event" && f.run_id === run.run_id && f.event.type === "agent_settled",
    );
  }
  const launchAt = (all: { argv: string[]; agentDir: string }[], n: number) => {
    const l = all[n];
    if (l === undefined) throw new Error(`launch ${n} missing`);
    return l;
  };
  const launches = async () =>
    (await h.commandsLog()).filter((c) => "argv" in c) as unknown as {
      argv: string[];
      agentDir: string;
    }[];

  it("a changed connector set restarts the idle Pi with a fresh mcp.json, the old dir is gone", async () => {
    h = await startHarness({ mcp: { proxyUrl: PROXY, tokens: fakeTokens(TOKEN_1) } });
    await settledRun(runStart("say:one", { mcp: MCP }));
    const first = launchAt(await launches(), 0);
    const firstFile = path.join(first.agentDir, "mcp.json");
    expect(JSON.parse(await readFile(firstFile, "utf8")).mcpServers).toHaveProperty("jira");

    await settledRun(runStart("say:two", { run_id: RUN_2, mcp: SECOND }));
    const all = await launches();
    expect(all).toHaveLength(2);
    const secondFile = path.join(launchAt(all, 1).agentDir, "mcp.json");
    const servers = JSON.parse(await readFile(secondFile, "utf8")).mcpServers;
    expect(Object.keys(servers)).toEqual(["wiki"]);
    expect(existsSync(firstFile)).toBe(false);
  });

  it("a changed tool list (re-pin, agent tools) restarts Pi too; an identical one reuses it", async () => {
    h = await startHarness({ mcp: { proxyUrl: PROXY, tokens: fakeTokens(TOKEN_1) } });
    await settledRun(runStart("say:one", { mcp: MCP }));
    await settledRun(runStart("say:two", { run_id: RUN_2, mcp: MCP }));
    expect(await launches()).toHaveLength(1);
    const narrowed = {
      servers: MCP.servers.map((sv) => ({
        ...sv,
        tools: [{ name: "x", pi_name: "mcp__jira__x" }],
      })),
    };
    await settledRun(
      runStart("say:three", { run_id: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6073", mcp: narrowed }),
    );
    expect(await launches()).toHaveLength(2);
  });

  it("losing every connector restarts Pi without the MCP extension or file", async () => {
    h = await startHarness({ mcp: { proxyUrl: PROXY, tokens: fakeTokens(TOKEN_1) } });
    await settledRun(runStart("say:one", { mcp: MCP }));
    await settledRun(runStart("say:two", { run_id: RUN_2, mcp: { servers: [] } }));
    const all = await launches();
    expect(all).toHaveLength(2);
    expect(launchAt(all, 1).argv).not.toContain("builtin:mcp");
    expect(existsSync(path.join(launchAt(all, 1).agentDir, "mcp.json"))).toBe(false);
    expect(existsSync(path.join(launchAt(all, 0).agentDir, "mcp.json"))).toBe(false);
  });
});
