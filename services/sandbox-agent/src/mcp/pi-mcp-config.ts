import { constants as FS } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunMcpContext } from "@kobe/protocol";
import type { ModelTokenSource } from "../models/types.js";

/**
 * Per-session MCP config for Pi (KOBE-111, 62a of KOBE-62). Pi 1.0.x reads MCP servers from
 * `mcp.json` in its config dir (`PI_CODING_AGENT_DIR`) when the `builtin:mcp` extension is loaded.
 * That dir is the thread's private, fresh-per-process one (KOBE-196/228), never the workspace.
 *
 * The file lists only the run's effective connectors (`run.start.mcp`), each as a Streamable HTTP
 * server at mcp-proxy's per-connector URL with this sandbox's `kobe.mcp-proxy` session token as
 * the bearer. Upstream URLs, API keys and OAuth tokens are never here (D27): the proxy resolves
 * the user's grant and attaches the credential. Tools are `exposure: hidden` except the listed
 * ones (`direct`), so Pi registers `mcp__<server>__<tool>` for exactly those and nothing else.
 */
export const MCP_CONFIG_FILE = "mcp.json";
/** The proxy's sandbox-facing endpoint is `POST /v1/mcp/{connector_id}` (services/mcp-proxy). */
const PROXY_PATH = "/v1/mcp";

export interface McpWiring {
  /** `KOBE_MCP_PROXY_URL`: an http(s) origin, no credentials. */
  readonly proxyUrl: string;
  /** The sandbox's rotating `kobe.mcp-proxy` session token. */
  readonly tokens: ModelTokenSource;
}

export function buildPiMcpConfig(input: {
  readonly proxyUrl: string;
  readonly token: string;
  readonly mcp: RunMcpContext;
}): string {
  const origin = input.proxyUrl.replace(/\/+$/, "");
  const mcpServers = Object.fromEntries(
    input.mcp.servers.map((server) => [
      server.name,
      {
        url: `${origin}${PROXY_PATH}/${server.connector_id}`,
        headers: { Authorization: `Bearer ${input.token}` },
        exposure: "hidden",
        toolExposure: Object.fromEntries(server.tools.map((t) => [t.name, "direct"])),
      },
    ]),
  );
  return `${JSON.stringify({ mcpServers, autoEnableCodemode: false }, null, 2)}\n`;
}

/**
 * Write `mcp.json` into Pi's config dir. Atomic (temp file + rename in the same dir) so a rotation
 * rewrite never leaves Pi a half-written file. Mode 0440 under a Pi identity (its group reads it),
 * else 0400, like the other files the agent places there.
 */
export async function writeMcpConfigFile(
  agentDir: string,
  text: string,
  shared: boolean,
): Promise<void> {
  const file = path.join(agentDir, MCP_CONFIG_FILE);
  const temp = `${file}.tmp`;
  await writeFile(temp, text, { mode: shared ? 0o440 : 0o400, flag: "w" });
  await rename(temp, file);
}

/** The files the agent puts in `agent/` for MCP (the temp file exists only during a rewrite). */
export const MCP_AGENT_FILES: ReadonlySet<string> = new Set([
  MCP_CONFIG_FILE,
  `${MCP_CONFIG_FILE}.tmp`,
]);

/**
 * Whether `mcp.json` is still one of the texts the agent wrote (the last two, as a rotation may
 * be mid-rename). Opened without following links or blocking, then checked: a tool can swap the
 * file at any moment. Detection only, like the other guarded files (docs/ledger/KOBE-71.md).
 */
export async function verifyMcpConfigFile(
  agentDir: string,
  accepted: readonly string[],
): Promise<boolean> {
  try {
    const handle = await open(
      path.join(agentDir, MCP_CONFIG_FILE),
      FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024) return false;
      return accepted.includes(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}
