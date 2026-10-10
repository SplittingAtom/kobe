import { constants as FS } from "node:fs";
import { chmod, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunMcpContext } from "@kobe/protocol";
import type { ModelTokenSource } from "../models/types.js";

/**
 * Per-session MCP config for Pi (KOBE-111, 62a of KOBE-62). Pi 1.0.x reads MCP servers from
 * `mcp.json` in its config dir (`PI_CODING_AGENT_DIR`) when the `builtin:mcp` extension is loaded.
 * That dir is the thread's private, fresh-per-process one (KOBE-196/228), never the workspace.
 *
 * `mcp.json` lists only the run's effective connectors (`run.start.mcp`), each as a Streamable HTTP
 * server at mcp-proxy's per-connector URL. Upstream URLs, API keys and OAuth tokens are never here
 * (D27): the proxy resolves the user's grant and attaches the credential. Tools are `exposure:
 * hidden` except the listed ones (`direct`), so Pi registers `mcp__<server>__<tool>` for exactly
 * those and nothing else.
 *
 * The session token is not in `mcp.json`. The `Authorization` header is a Pi config command
 * (`!cat '<fixed path>'`, the same `!command` values Pi accepts for provider keys) that Pi runs
 * each time it opens a connection and that prints the `agent/mcp-token` file, which the agent
 * rewrites (atomically) whenever the token rotates. If a long-lived connection's token expires,
 * the proxy answers its requests with 404 on the MCP session; Pi then opens a new session, runs the
 * command again and retries once (mcp-proxy `isExpiredSandboxToken`). The command is built from a
 * path the agent chose (checked against a strict pattern), with no input from tools or the model.
 */
export const MCP_CONFIG_FILE = "mcp.json";
/** The file the header command prints: `Bearer <kobe.mcp-proxy token>`. */
export const MCP_TOKEN_FILE = "mcp-token";
/** The proxy's sandbox-facing endpoint is `POST /v1/mcp/{connector_id}` (services/mcp-proxy). */
const PROXY_PATH = "/v1/mcp";
/** Runtime dirs are `mkdtemp` names under an absolute path: nothing a shell would interpret. */
const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;

export interface McpWiring {
  /** `KOBE_MCP_PROXY_URL`: an http(s) origin, no credentials. */
  readonly proxyUrl: string;
  /** The sandbox's rotating `kobe.mcp-proxy` session token. */
  readonly tokens: ModelTokenSource;
}

/** The text of the token file for a session token. */
export function mcpTokenFileText(token: string): string {
  return `Bearer ${token}\n`;
}

export function buildPiMcpConfig(input: {
  readonly proxyUrl: string;
  /** Absolute path of the token file the header command prints. */
  readonly tokenFile: string;
  readonly mcp: RunMcpContext;
}): string {
  if (!SAFE_PATH.test(input.tokenFile)) throw new Error("unsafe MCP token file path");
  const origin = input.proxyUrl.replace(/\/+$/, "");
  const mcpServers = Object.fromEntries(
    input.mcp.servers.map((server) => [
      server.name,
      {
        url: `${origin}${PROXY_PATH}/${server.connector_id}`,
        headers: { Authorization: `!cat '${input.tokenFile}'` },
        exposure: "hidden",
        toolExposure: Object.fromEntries(server.tools.map((t) => [t.name, "direct"])),
      },
    ]),
  );
  return `${JSON.stringify({ mcpServers, autoEnableCodemode: false }, null, 2)}\n`;
}

/**
 * Write a file into Pi's config dir. Atomic (temp file + rename in the same dir) so a reader never
 * sees a half-written file. Mode 0440 under a Pi identity (its group reads it), else 0400, like the
 * other files the agent places there.
 */
export async function writeAgentFile(
  agentDir: string,
  name: string,
  text: string,
  shared: boolean,
): Promise<void> {
  const file = path.join(agentDir, name);
  const temp = `${file}.tmp`;
  const mode = shared ? 0o440 : 0o400;
  await writeFile(temp, text, { mode, flag: "w" });
  // writeFile's mode is filtered by the agent's umask (077), which would drop the group's read bit
  // and leave Pi (a different uid, in the file's group) unable to read its own MCP config.
  await chmod(temp, mode);
  await rename(temp, file);
}

/** The files the agent puts in `agent/` for MCP (the temp files exist only during a write). */
export const MCP_AGENT_FILES: ReadonlySet<string> = new Set(
  [MCP_CONFIG_FILE, MCP_TOKEN_FILE].flatMap((name) => [name, `${name}.tmp`]),
);

/**
 * Whether an agent-written file is still one of the texts the agent wrote (the last two, as a
 * rotation may be mid-rename). Opened without following links or blocking, then checked: a tool
 * can swap the file at any moment. Detection only, like the other guarded files
 * (docs/ledger/KOBE-71.md).
 */
export async function verifyAgentFile(
  agentDir: string,
  name: string,
  accepted: readonly string[],
): Promise<boolean> {
  try {
    const handle = await open(
      path.join(agentDir, name),
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
