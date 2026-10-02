import { Hono } from "hono";
import { IsolationRuntimeMissingError } from "../isolation/gate.js";
import { logger } from "../logger.js";
import type { SessionKeys } from "../sandbox/config.js";
import { SandboxAuthError, type SandboxProvider } from "../sandbox/provider.js";
import { issueSessionTokens } from "../sandbox/session-token.js";

/** How long an unclaimed warm-pool pod waits before asking again. */
export const UNASSIGNED_RETRY_MS = 2_000;

/**
 * Proxies and ingress controllers add these; sandboxes call the server's Service directly. The
 * sandbox endpoints are cluster-internal, so a request that came through the ingress is refused.
 */
const FORWARDED_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];

export interface SandboxRoutesDeps {
  readonly provider: Pick<SandboxProvider, "identifyBootstrapToken">;
  readonly sessionKeys: SessionKeys;
  readonly now?: () => Date;
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
  const { provider, sessionKeys, now = () => new Date() } = deps;
  const app = new Hono();

  app.use(async (c, next) => {
    if (FORWARDED_HEADERS.some((h) => c.req.header(h) !== undefined)) {
      return c.json({ code: "not_found", message: "Not found." }, 404);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.post("/session", async (c) => {
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
