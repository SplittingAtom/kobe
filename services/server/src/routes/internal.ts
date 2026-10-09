import { createHash, timingSafeEqual } from "node:crypto";
import { honoTracing } from "@kobe/telemetry";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { idSchema, uuidSchema } from "@kobe/protocol";
import { logger } from "../logger.js";
import { authenticateSandbox, type McpAuthDeps } from "../mcp/principal.js";
import type { McpService } from "../mcp/service.js";
import { createRateLimiter, type RateLimiter } from "../sandbox/rate-limit.js";

/**
 * The server's internal listener (port 8082): the MCP proxy's policy re-check (KOBE-58). Not on the
 * user app (ingress) nor the sandbox listener (8081, which sandboxes reach): the release
 * NetworkPolicy admits only the MCP proxy's pods to this port, and every request must carry the
 * proxy's internal key. The caller's identity is the sandbox's own `kobe.mcp-proxy` session token
 * (`Kobe-Sandbox-Token`), which the server verifies itself: the proxy cannot speak for a sandbox
 * whose token it has not seen.
 *
 * POST /internal/v1/mcp/connectors/{id}/tools → 200 `{connector, tools}` (pinned + exposed)
 * POST /internal/v1/mcp/connectors/{id}/calls  `{tool, arguments, thread_id?, tool_call_id?}`
 *      → 200 `{decision: "allow", connector, tool, input_sha256, reason, approval_id?}`
 *      | 200 `{decision: "deny", code, message, approval_failure?}`
 * 401 `unauthorized` (internal key), 401 `sandbox_unauthorized` (token, liveness, membership),
 * POST /internal/v1/mcp/connectors/{id}/grant → 200 `{kind: "api_key", api_key}` for the sandbox's own
 *      user only (KOBE-108); 404 `not_connected` | `connector_not_available`, 503 `unavailable`
 * 429 `rate_limited` (per sandbox, `DECIDE_RATE`),
 * 404 `connector_not_available`, 400 `invalid_request`.
 */
export const INTERNAL_KEY_MIN_LENGTH = 32;
/** Tool inputs are at most 1 MiB at the proxy; the envelope adds a little. */
export const INTERNAL_BODY_LIMIT = 1_200_000;
/**
 * Decisions per sandbox, across all proxy replicas of this server replica (review L5): a backstop
 * behind the proxy's own per-replica rate limit (burst 60, then 10/s).
 */
export const DECIDE_RATE = { capacity: 120, refillPerSecond: 20 } as const;

const FORWARDED_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];

export interface InternalAppDeps {
  /** Shared with the MCP proxy (chart-generated Secret). */
  readonly internalKey: string;
  readonly mcp: McpService;
  readonly auth: McpAuthDeps;
  readonly decideLimiter?: RateLimiter;
}

const callBodySchema = z.strictObject({
  tool: z.string().min(1).max(128),
  arguments: z.unknown().optional(),
  thread_id: uuidSchema.optional(),
  tool_call_id: idSchema.optional(),
});

const digest = (value: string) => createHash("sha256").update(value).digest();

export function createInternalApp(deps: InternalAppDeps): Hono {
  if (deps.internalKey.length < INTERNAL_KEY_MIN_LENGTH) {
    throw new Error(`the internal key must be at least ${INTERNAL_KEY_MIN_LENGTH} characters`);
  }
  const keyDigest = digest(`Bearer ${deps.internalKey}`);
  const decideLimiter = deps.decideLimiter ?? createRateLimiter(DECIDE_RATE);
  const app = new Hono();
  app.use("*", honoTracing());
  app.get("/healthz", (c) => c.json({ status: "ok", service: "server-internal" }));

  const mcp = new Hono();
  mcp.use(async (c, next) => {
    if (FORWARDED_HEADERS.some((h) => c.req.header(h) !== undefined)) {
      return c.json({ code: "not_found", message: "Not found." }, 404);
    }
    if (!timingSafeEqual(digest(c.req.header("authorization") ?? ""), keyDigest)) {
      return c.json({ code: "unauthorized", message: "Internal key required." }, 401);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });
  mcp.use(
    bodyLimit({
      maxSize: INTERNAL_BODY_LIMIT,
      onError: (c) => c.json({ code: "invalid_request", message: "Body too large." }, 413),
    }),
  );

  const principalOf = async (token: string | undefined) => {
    const result = await authenticateSandbox(deps.auth, token);
    if (!result.ok) logger.info({ code: result.code }, "mcp: sandbox token refused");
    return result;
  };
  const connectorId = (raw: string) => uuidSchema.safeParse(raw);

  mcp.post("/connectors/:id/tools", async (c) => {
    const id = connectorId(c.req.param("id"));
    if (!id.success) return c.json({ code: "connector_not_available", message: "Not found." }, 404);
    const auth = await principalOf(c.req.header("kobe-sandbox-token"));
    if (!auth.ok) return c.json({ code: "sandbox_unauthorized", message: auth.code }, 401);
    const listed = await deps.mcp.listTools(auth.principal, id.data);
    if (!listed) {
      return c.json(
        { code: "connector_not_available", message: "Not enabled for this team." },
        404,
      );
    }
    return c.json(listed);
  });

  // The caller's own API key for the upstream request (KOBE-108). The user comes from the verified
  // sandbox token only; the proxy puts the key on the upstream request and nowhere else.
  mcp.post("/connectors/:id/grant", async (c) => {
    const id = connectorId(c.req.param("id"));
    if (!id.success) return c.json({ code: "connector_not_available", message: "Not found." }, 404);
    const auth = await principalOf(c.req.header("kobe-sandbox-token"));
    if (!auth.ok) return c.json({ code: "sandbox_unauthorized", message: auth.code }, 401);
    const revealed = await deps.mcp.revealCredential(auth.principal, id.data);
    if (revealed.ok) return c.json({ kind: "api_key", api_key: revealed.apiKey });
    if (revealed.failure === "not_available") {
      return c.json(
        { code: "connector_not_available", message: "Not enabled for this team." },
        404,
      );
    }
    if (revealed.failure === "not_connected") {
      return c.json({ code: "not_connected", message: "No key stored." }, 404);
    }
    return c.json({ code: "unavailable", message: "Credential unavailable." }, 503);
  });

  mcp.post("/connectors/:id/calls", async (c) => {
    const id = connectorId(c.req.param("id"));
    if (!id.success) return c.json({ code: "connector_not_available", message: "Not found." }, 404);
    const body = callBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "invalid_request", message: "Invalid call." }, 400);
    const auth = await principalOf(c.req.header("kobe-sandbox-token"));
    if (!auth.ok) return c.json({ code: "sandbox_unauthorized", message: auth.code }, 401);
    const wait = decideLimiter.take(auth.principal.sandboxId);
    if (wait > 0) {
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return c.json({ code: "rate_limited", message: "Too many calls." }, 429);
    }
    const decision = await deps.mcp.decide(auth.principal, {
      connectorId: id.data,
      tool: body.data.tool,
      arguments: body.data.arguments,
      ...(body.data.thread_id === undefined ? {} : { threadId: body.data.thread_id }),
      ...(body.data.tool_call_id === undefined ? {} : { toolCallId: body.data.tool_call_id }),
    });
    return c.json(decision);
  });

  app.route("/internal/v1/mcp", mcp);
  return app;
}
