import { getConnInfo } from "@hono/node-server/conninfo";
import { SKILL_BUNDLE_PATH, SKILL_EVAL_FIXTURES_PATH, WORKSPACE_SYNC_PATH } from "@kobe/protocol";
import { Hono, type Context } from "hono";
import { honoTracing, skipRequestTrace } from "@kobe/telemetry";
import { IsolationRuntimeMissingError } from "../isolation/gate.js";
import { logger } from "../logger.js";
import type { SessionKeys } from "../sandbox/config.js";
import { SandboxAuthError, type SandboxProvider } from "../sandbox/provider.js";
import { createRateLimiter, type RateLimiter } from "../sandbox/rate-limit.js";
import { issueSessionTokens } from "../sandbox/session-token.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";

/** How long an unclaimed warm-pool pod waits before asking again (a client that did not wait). */
export const UNASSIGNED_RETRY_MS = 2_000;

/**
 * Long-poll for an unclaimed warm-pool pod (KOBE-417). A client sending `Prefer: wait=<s>` (RFC
 * 7240) is held while its pod is unassigned, re-identified every `recheckMs`, and answered as soon
 * as the claim lands (claim → grant ≤ `recheckMs`), or with 409 + `Preference-Applied` after at
 * most `maxWaitMs`. One request per ~20 s per idle pod instead of one every 2 s.
 */
export const SESSION_WAIT = { maxWaitMs: 20_000, recheckMs: 1_000 } as const;

/** After a held 409, the client may ask again at once (it backs off itself when not held). */
const WAITED_RETRY_MS = 250;

/** Seconds from `Prefer: wait=<n>`, or undefined when the client did not ask to wait. */
export function preferredWaitSeconds(prefer: string | undefined): number | undefined {
  const m = /(?:^|[,;\s])wait=(\d{1,6})(?:$|[,;\s])/i.exec(prefer ?? "");
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

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
  /** Session token lifetime in seconds (KOBE_SESSION_TOKEN_TTL_SECONDS); default 15 min. */
  readonly sessionTokenTtlSeconds?: number;
  readonly now?: () => Date;
  readonly limiter?: RateLimiter;
  /** Rate-limit key for a request (default: the peer address of the TCP connection). */
  readonly sourceOf?: (c: Context) => string;
  /** Workspace sync endpoints (KOBE-27); absent when object storage is not configured. */
  readonly workspace?: ReturnType<WorkspaceSync["routes"]>;
  /** Long-poll bounds while a pod is unassigned (default {@link SESSION_WAIT}). */
  readonly unassignedWait?: { readonly maxWaitMs: number; readonly recheckMs: number };
  readonly sleep?: (ms: number) => Promise<void>;
  /** Skill bundle downloads (KOBE-82); absent when object storage is not configured. */
  readonly skills?: Hono;
  /** A skill eval case's fixtures for its own sandbox (KOBE-325). */
  readonly evalFixtures?: Hono;
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
  app.use("*", honoTracing({ joinCallerTrace: false }));
  app.get("/healthz", (c) => c.json({ status: "ok", service: "server-sandbox" }));
  // Sandbox endpoints are cluster-internal: anything that came through the ingress is refused.
  app.use("/v1/sandbox/*", async (c, next) => {
    if (FORWARDED_HEADERS.some((h) => c.req.header(h) !== undefined)) {
      return c.json({ code: "not_found", message: "Not found." }, 404);
    }
    await next();
  });
  if (deps.workspace) app.route(WORKSPACE_SYNC_PATH, deps.workspace);
  if (deps.skills) app.route(SKILL_BUNDLE_PATH, deps.skills);
  if (deps.evalFixtures) app.route(SKILL_EVAL_FIXTURES_PATH, deps.evalFixtures);
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
 * - 409 `sandbox_unassigned` + `retry_after_ms`: a warm-pool pod nobody has claimed yet. With
 *   `Prefer: wait=<s>` the request is first held (long-poll, {@link SESSION_WAIT}) and the 409 then
 *   carries `Preference-Applied: wait=<s>`. These routine answers are not traced (KOBE-417).
 * - 401 `unauthorized`: not a live Kobe sandbox pod's token.
 * - 503 `isolation_runtime_missing` / `sandbox_unavailable`.
 */
export function sandboxRoutes(deps: SandboxRoutesDeps): Hono {
  const {
    provider,
    sessionKeys,
    sessionTokenTtlSeconds,
    now = () => new Date(),
    limiter = createRateLimiter(SESSION_RATE),
    sourceOf = peerAddress,
    unassignedWait = SESSION_WAIT,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
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
    const token = match[1];
    try {
      const preferred = preferredWaitSeconds(c.req.header("prefer"));
      const waitMs =
        preferred === undefined ? 0 : Math.min(preferred * 1000, unassignedWait.maxWaitMs);
      const signal = c.req.raw.signal;
      let identity = await provider.identifyBootstrapToken(token);
      for (
        let waited = 0;
        identity.state === "unassigned" && waited < waitMs && !signal.aborted;
        waited += unassignedWait.recheckMs
      ) {
        await sleep(Math.min(unassignedWait.recheckMs, waitMs - waited));
        if (signal.aborted) break;
        identity = await provider.identifyBootstrapToken(token);
      }
      if (identity.state === "unassigned") {
        // Routine (every idle warm-pool pod, all the time): not worth a trace each (KOBE-417).
        skipRequestTrace(c);
        if (waitMs > 0) c.header("Preference-Applied", `wait=${Math.round(waitMs / 1000)}`);
        return c.json(
          {
            code: "sandbox_unassigned",
            message: "This sandbox has not been assigned yet.",
            retry_after_ms: waitMs > 0 ? WAITED_RETRY_MS : UNASSIGNED_RETRY_MS,
          },
          409,
        );
      }
      const { principal } = identity;
      const issued = issueSessionTokens(principal, sessionKeys, now(), sessionTokenTtlSeconds);
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
