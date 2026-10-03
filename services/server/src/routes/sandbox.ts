import { getConnInfo } from "@hono/node-server/conninfo";
import { WORKSPACE_SYNC_PATH } from "@kobe/protocol";
import { Hono, type Context } from "hono";
import { IsolationRuntimeMissingError } from "../isolation/gate.js";
import { logger } from "../logger.js";
import type { SessionKeys } from "../sandbox/config.js";
import { SandboxAuthError, type SandboxProvider } from "../sandbox/provider.js";
import { createRateLimiter, type RateLimiter } from "../sandbox/rate-limit.js";
import { issueSessionTokens } from "../sandbox/session-token.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";

/** How long an unclaimed warm-pool pod waits before asking again. */
export const UNASSIGNED_RETRY_MS = 2_000;

/**
 * Proxies and ingress controllers add these; sandboxes call the server's Service directly. The
 * sandbox endpoints are cluster-internal, so a request that came through the ingress is refused.
 */
const FORWARDED_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];

/** Session exchanges per source pod: a burst of 20, then one per second (each costs a TokenReview). */
export const SESSION_RATE = { capacity: 20, refillPerSecond: 1 } as const;

export interface SandboxRoutesDeps {
  readonly provider: Pick<SandboxProvider, "identifyBootstrapToken">;
  readonly sessionKeys: SessionKeys;
  readonly now?: () => Date;
  readonly limiter?: RateLimiter;
  /** Rate-limit key for a request (default: the peer address of the TCP connection). */
  readonly sourceOf?: (c: Context) => string;
  /** Workspace sync endpoints (KOBE-27); absent when object storage is not configured. */
  readonly workspace?: ReturnType<WorkspaceSync["routes"]>;
}

function peerAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The sandbox-facing HTTP app. It runs on its own listener/port (the sandbox NetworkPolicy allows
 * only that port on server pods), so sandboxes cannot reach the user API, auth or setup routes,
 * and the ingress never routes to it. KOBE-24 adds the WebSocket here.
 */
export function createSandboxApp(deps: SandboxRoutesDeps): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok", service: "server-sandbox" }));
  // Sandbox endpoints are cluster-internal: anything that came through the ingress is refused.
  app.use("/v1/sandbox/*", async (c, next) => {
    if (FORWARDED_HEADERS.some((h) => c.req.header(h) !== undefined)) {
      return c.json({ code: "not_found", message: "Not found." }, 404);
    }
    await next();
  });
  if (deps.workspace) app.route(WORKSPACE_SYNC_PATH, deps.workspace);
  app.route("/v1/sandbox", sandboxRoutes(deps));
  return app;
}

/**
 * Sandbox-facing endpoints, mounted at /v1/sandbox outside the session-authenticated API.
 *
 * POST /session — `Authorization: Bearer <projected bootstrap token>` (file at
 * KOBE_BOOTSTRAP_TOKEN_FILE in the pod). Answers:
 * - 200 `{sandbox_id, team_id, user_id, expires_at, tokens: {<audience>: <token>}}`: one session
 *   token per audience (packages/protocol session-token.ts). Re-trade before `expires_at`.
 * - 409 `sandbox_unassigned` + `retry_after_ms`: a warm-pool pod nobody has claimed yet.
 * - 401 `unauthorized`: not a live Kobe sandbox pod's token.
 * - 503 `isolation_runtime_missing` / `sandbox_unavailable`.
 */
export function sandboxRoutes(deps: SandboxRoutesDeps): Hono {
  const {
    provider,
    sessionKeys,
    now = () => new Date(),
    limiter = createRateLimiter(SESSION_RATE),
    sourceOf = peerAddress,
  } = deps;
  const app = new Hono();

  app.use(async (c, next) => {
    if (FORWARDED_HEADERS.some((h) => c.req.header(h) !== undefined)) {
      return c.json({ code: "not_found", message: "Not found." }, 404);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.post("/session", async (c) => {
    const wait = limiter.take(sourceOf(c));
    if (wait > 0) {
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return c.json(
        { code: "rate_limited", message: "Too many requests.", retry_after_ms: wait },
        429,
      );
    }
    const match = /^Bearer ([^\s]+)$/.exec(c.req.header("authorization") ?? "");
    if (!match?.[1]) {
      return c.json({ code: "unauthorized", message: "Bearer bootstrap token required." }, 401);
    }
    try {
      const identity = await provider.identifyBootstrapToken(match[1]);
      if (identity.state === "unassigned") {
        return c.json(
          {
            code: "sandbox_unassigned",
            message: "This sandbox has not been assigned yet.",
            retry_after_ms: UNASSIGNED_RETRY_MS,
          },
          409,
        );
      }
      const { principal } = identity;
      const issued = issueSessionTokens(principal, sessionKeys, now());
      logger.info(
        { sandboxId: principal.sandboxId, teamId: principal.teamId, pod: identity.podName },
        "sandbox session tokens issued",
      );
      return c.json({
        sandbox_id: principal.sandboxId,
        team_id: principal.teamId,
        user_id: principal.userId,
        expires_at: issued.expiresAt.toISOString(),
        tokens: issued.tokens,
      });
    } catch (err) {
      if (err instanceof SandboxAuthError) {
        logger.warn({ reason: err.detail }, "sandbox bootstrap token refused");
        return c.json({ code: "unauthorized", message: "Not a Kobe sandbox." }, 401);
      }
      if (err instanceof IsolationRuntimeMissingError) {
        logger.error({ err: err.message }, "sandbox session refused: isolation runtime missing");
        return c.json(err.toResponseBody(), 503);
      }
      logger.error({ err }, "sandbox session failed");
      return c.json(
        { code: "sandbox_unavailable", message: "Sandbox credentials are unavailable; retry." },
        503,
      );
    }
  });

  return app;
}
