import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { canonicalJson, toolInputSchema, uuidSchema } from "@kobe/protocol";
import { bearerToken, verifySandboxToken } from "./auth.js";
import type { Limits } from "./config.js";
import type { CredentialResolver } from "./credentials.js";
import { JSONRPC_ERRORS, parseMessage, rpcError, rpcResult, type JsonRpcId } from "./jsonrpc.js";
import type { Limiter } from "./limits.js";
import type { ExposedTool, PolicyServer } from "./server-client.js";
import type { UpstreamClient, UpstreamFailure } from "./upstream.js";

/**
 * The sandbox-facing MCP endpoint (D27): `POST /v1/mcp/{connector_id}`, MCP Streamable HTTP,
 * stateless (no `Mcp-Session-Id`: every request carries the sandbox's session token), JSON answers
 * only. Pi's MCP client talks only to this endpoint; the proxy talks to the remote server.
 *
 * - `initialize`, `ping`, `tools/list` (the connector's **pinned** tools the team exposes, from the
 *   server — never the live upstream list), `tools/call`. Resources and prompts are not offered in
 *   v1 (D27 "later"): method not found.
 * - Every `tools/call` is decided by the server first (policy re-check, signed approval for calls
 *   that need one, audit). Only an `allow` for exactly this connector, tool and input is forwarded,
 *   and what is forwarded is `JSON.parse(canonicalJson(arguments))` — the bytes that were decided.
 * - Per-call context: `Kobe-Thread-Id` header (the Pi process's thread; KOBE-62 sets it per
 *   session) and optional `params._meta["kobe.dev/tool_call_id"]`. Both are claims the server checks.
 */

/** Versions the proxy answers to Pi (`pi-mcp` speaks 2025-11-25), newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SERVER_INFO = { name: "kobe-mcp-proxy", version: "1.0.0" } as const;
export const THREAD_HEADER = "kobe-thread-id";
export const TOOL_CALL_ID_META_KEY = "kobe.dev/tool_call_id";

export interface McpRouteDeps {
  readonly sessionKey: string;
  readonly server: PolicyServer;
  readonly upstream: UpstreamClient;
  readonly credentials: CredentialResolver;
  readonly limiter: Limiter;
  readonly limits: Limits;
  readonly log: Logger;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A tool error the model sees (MCP `isError` result): the call did not run upstream. */
function toolError(id: JsonRpcId, text: string) {
  return rpcResult(id, { content: [{ type: "text", text }], isError: true });
}

const UPSTREAM_MESSAGES: Readonly<Record<UpstreamFailure, string>> = {
  url_not_allowed: "The connector's address is not allowed by this Kobe install.",
  forbidden_address: "The connector's server resolves to an address Kobe may not reach.",
  unreachable: "The connector's server could not be reached.",
  timeout: "The connector's server did not answer in time.",
  auth_required: "The connector's server refused the credentials. Reconnect it in Kobe settings.",
  http_error: "The connector's server answered with an error.",
  protocol_error: "The connector's server did not answer as an MCP server.",
  too_large: "The connector's answer was too large.",
};

function toMcpTool(tool: ExposedTool): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
    inputSchema: tool.input_schema,
    ...(tool.output_schema === undefined ? {} : { outputSchema: tool.output_schema }),
    ...(tool.annotations === undefined || Object.keys(tool.annotations).length === 0
      ? {}
      : { annotations: tool.annotations }),
  };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function mcpRoutes(deps: McpRouteDeps): Hono {
  const app = new Hono();

  app.on(["GET", "DELETE", "PUT", "PATCH"], "/:connectorId", (c) => {
    c.header("Allow", "POST");
    return c.json(rpcError(null, JSONRPC_ERRORS.invalidRequest, "Only POST is supported."), 405);
  });

  app.post(
    "/:connectorId",
    bodyLimit({
      maxSize: deps.limits.maxRequestBytes,
      onError: (c) =>
        c.json(rpcError(null, JSONRPC_ERRORS.invalidRequest, "Request too large."), 413),
    }),
    async (c) => handlePost(deps, c),
  );
  return app;
}

async function handlePost(deps: McpRouteDeps, c: Context): Promise<Response> {
  c.header("Cache-Control", "no-store");
  const token = bearerToken(c.req.header("authorization"));
  const claims = verifySandboxToken(token, deps.sessionKey);
  if (!token || !claims) {
    c.header("WWW-Authenticate", 'Bearer realm="kobe-mcp-proxy"');
    return c.json(rpcError(null, JSONRPC_ERRORS.invalidRequest, "Unauthorized."), 401);
  }
  if (!deps.limiter.takeRequest(claims.sub)) {
    c.header("Retry-After", "1");
    return c.json(rpcError(null, JSONRPC_ERRORS.invalidRequest, "Too many requests."), 429);
  }
  const connectorId = uuidSchema.safeParse(c.req.param("connectorId"));
  if (!connectorId.success) {
    return c.json(rpcError(null, JSONRPC_ERRORS.invalidRequest, "Unknown connector."), 404);
  }
  const version = c.req.header("mcp-protocol-version");
  if (
    version !== undefined &&
    !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)
  ) {
    return c.json(
      rpcError(null, JSONRPC_ERRORS.invalidRequest, "Unsupported protocol version."),
      400,
    );
  }
  const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    return c.json(rpcError(null, JSONRPC_ERRORS.invalidRequest, "Content-Type must be JSON."), 415);
  }
  const parsed = parseMessage(await c.req.text());
  if (!parsed.ok) return c.json(rpcError(null, parsed.code, parsed.message), 400);
  const message = parsed.message;
  if (message.kind !== "request") return c.body(null, 202);

  const ctx: CallContext = {
    deps,
    token,
    connectorId: connectorId.data,
    teamId: claims.team_id,
    userId: claims.user_id,
    sandboxId: claims.sub,
    threadHeader: c.req.header(THREAD_HEADER),
  };
  switch (message.method) {
    case "initialize":
      return c.json(...(await initialize(ctx, message.id, message.params)));
    case "ping":
      return c.json(rpcResult(message.id, {}));
    case "tools/list":
      return c.json(...(await listTools(ctx, message.id)));
    case "tools/call":
      return c.json(...(await callTool(ctx, message.id, message.params)));
    default:
      return c.json(
        rpcError(message.id, JSONRPC_ERRORS.methodNotFound, `${message.method} is not supported.`),
      );
  }
}

interface CallContext {
  readonly deps: McpRouteDeps;
  readonly token: string;
  readonly connectorId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly sandboxId: string;
  readonly threadHeader: string | undefined;
}

type Answer = [body: unknown, status?: 200 | 401 | 403 | 429 | 503];

function serverFailure(id: JsonRpcId, failure: string): Answer {
  if (failure === "sandbox_unauthorized") {
    return [rpcError(id, JSONRPC_ERRORS.invalidRequest, "Unauthorized."), 401];
  }
  if (failure === "not_available") {
    return [rpcError(id, JSONRPC_ERRORS.invalidRequest, "This connector is not available."), 403];
  }
  return [rpcError(id, JSONRPC_ERRORS.internal, "Kobe could not be reached; try again."), 503];
}

async function initialize(ctx: CallContext, id: JsonRpcId, params: unknown): Promise<Answer> {
  const requested = isObject(params) ? params.protocolVersion : undefined;
  const version =
    typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : SUPPORTED_PROTOCOL_VERSIONS[0];
  // Only connectors the team enabled exist for this sandbox.
  const listed = await ctx.deps.server.listTools(ctx.token, ctx.connectorId);
  if (!listed.ok) return serverFailure(id, listed.failure);
  return [
    rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    }),
  ];
}

async function listTools(ctx: CallContext, id: JsonRpcId): Promise<Answer> {
  const listed = await ctx.deps.server.listTools(ctx.token, ctx.connectorId);
  if (!listed.ok) return serverFailure(id, listed.failure);
  return [rpcResult(id, { tools: listed.value.tools.map(toMcpTool) })];
}

async function callTool(ctx: CallContext, id: JsonRpcId, params: unknown): Promise<Answer> {
  const { deps } = ctx;
  if (!isObject(params) || typeof params.name !== "string" || params.name.length > 128) {
    return [rpcError(id, JSONRPC_ERRORS.invalidParams, "tools/call needs a tool name.")];
  }
  // Protocol order (approval.ts): strict parse (done), `toolInputSchema`, then the re-check.
  const rawArgs = toolInputSchema.safeParse(params.arguments ?? {});
  if (!rawArgs.success) {
    return [
      rpcError(id, JSONRPC_ERRORS.invalidParams, "Tool arguments must be a safe JSON object."),
    ];
  }
  let canonical: string;
  try {
    canonical = canonicalJson(rawArgs.data);
  } catch {
    return [rpcError(id, JSONRPC_ERRORS.invalidParams, "Tool arguments are not valid JSON data.")];
  }
  // What is decided is what is forwarded: the canonical form, parsed once.
  const args = JSON.parse(canonical) as Record<string, unknown>;
  const meta = isObject(params._meta) ? params._meta : {};
  const toolCallId = meta[TOOL_CALL_ID_META_KEY];
  const thread = uuidSchema.safeParse(ctx.threadHeader);

  const release = deps.limiter.acquireCall(ctx.sandboxId);
  if (!release) return [rpcError(id, JSONRPC_ERRORS.internal, "Too many calls in flight."), 429];
  const started = Date.now();
  const log = (fields: Record<string, unknown>) =>
    deps.log.info(
      {
        sandboxId: ctx.sandboxId,
        teamId: ctx.teamId,
        connectorId: ctx.connectorId,
        tool: params.name,
        ms: Date.now() - started,
        ...fields,
      },
      "mcp tools/call",
    );
  try {
    const decided = await deps.server.decide(ctx.token, {
      connectorId: ctx.connectorId,
      tool: params.name,
      arguments: args,
      ...(thread.success ? { threadId: thread.data } : {}),
      ...(typeof toolCallId === "string" && toolCallId.length <= 128 ? { toolCallId } : {}),
    });
    if (!decided.ok) {
      log({ outcome: "refused", reason: decided.failure });
      if (decided.failure === "unavailable") {
        return [toolError(id, "Kobe could not check this call, so it was not run. Try again.")];
      }
      return serverFailure(id, decided.failure);
    }
    const decision = decided.value;
    if (decision.decision === "deny") {
      log({ outcome: "denied", reason: decision.code, approvalFailure: decision.approval_failure });
      return [toolError(id, `Kobe denied this call: ${decision.message}`)];
    }
    // Defence in depth: the allow must be for exactly this connector, tool and input.
    if (
      decision.connector.id !== ctx.connectorId ||
      decision.tool.name !== params.name ||
      decision.input_sha256 !== sha256(canonical)
    ) {
      deps.log.error({ sandboxId: ctx.sandboxId }, "mcp: server allowed a different call; refused");
      return [toolError(id, "Kobe could not check this call, so it was not run.")];
    }
    const credentials = await deps.credentials.headersFor({
      teamId: ctx.teamId,
      userId: ctx.userId,
      connector: decision.connector,
    });
    if (!credentials.ok) {
      log({ outcome: "refused", reason: credentials.code });
      return [
        toolError(
          id,
          credentials.code === "not_connected"
            ? `Connect your account for ${decision.connector.name} in Kobe settings first.`
            : "Your connector credentials are unavailable right now. Try again.",
        ),
      ];
    }
    const result = await deps.upstream.callTool({
      url: decision.connector.url,
      headers: credentials.headers,
      tool: decision.tool.name,
      arguments: args,
      signal: AbortSignal.timeout(deps.limits.upstreamTimeoutMs),
    });
    if (result.ok) {
      log({ outcome: "ok", approvalId: decision.approval_id, reason: decision.reason });
      return [rpcResult(id, result.result)];
    }
    log({ outcome: "upstream_failed", reason: result.failure });
    if (result.failure === "rpc_error") return [rpcError(id, result.code, result.message)];
    return [toolError(id, UPSTREAM_MESSAGES[result.failure])];
  } finally {
    release();
  }
}
