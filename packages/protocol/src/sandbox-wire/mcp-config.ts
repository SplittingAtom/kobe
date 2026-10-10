import { z } from "zod";
import { uuidSchema } from "../common.js";
import { connectorNameSchema } from "../tools.js";

/**
 * Per-session MCP config for Pi (KOBE-111, 62a of KOBE-62; spec D27). Additive: the server sends
 * `run.start.mcp` only to agents whose `hello.capabilities` lists {@link CAPABILITY_MCP}; an older
 * agent never sees the field (the run then has no connector tools, as before).
 *
 * The field names only the run's EFFECTIVE connectors (team-exposed, the run's user has a usable
 * grant, the agent's tool list allows at least the listed tools) and their tools. It carries no
 * URL, no credential and no token: the agent builds Pi's `mcp.json` from its own mcp-proxy URL
 * (`KOBE_MCP_PROXY_URL`) and its own `kobe.mcp-proxy` session token, so nothing about the upstream
 * server or the user's grant ever reaches the sandbox. Empty `servers` means "no connectors": Pi
 * is then started without the MCP extension.
 */
export const CAPABILITY_MCP = "mcp";

export const RUN_MCP_SERVERS_MAX = 64;
export const RUN_MCP_TOOLS_MAX = 256;

/** `mcp__<server segment>__<tool>`: the name Pi registers and kobe-policy checks. */
const piToolName = z
  .string()
  .max(256)
  .regex(/^mcp__[A-Za-z0-9_]+?__.+$/, "mcp__<server>__<tool>");

export const runMcpServerSchema = z.strictObject({
  /** The connector's name (also Pi's `mcp.json` server key). */
  name: connectorNameSchema,
  connector_id: uuidSchema,
  /** The tools the agent may see: the MCP tool name and its Pi name. */
  tools: z
    .array(z.strictObject({ name: z.string().min(1).max(256), pi_name: piToolName }))
    .max(RUN_MCP_TOOLS_MAX),
});
export type RunMcpServer = z.infer<typeof runMcpServerSchema>;

export const runMcpContextSchema = z.strictObject({
  servers: z.array(runMcpServerSchema).max(RUN_MCP_SERVERS_MAX),
});
export type RunMcpContext = z.infer<typeof runMcpContextSchema>;
