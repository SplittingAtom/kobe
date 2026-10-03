import {
  createServer,
  request as httpRequest,
  Agent as HttpAgent,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import type { SessionTokenClaims } from "@kobe/protocol";
import { SessionTokenError } from "@kobe/session-token";
import type { Logger } from "pino";
import { extractCredential } from "./credentials.js";
import { forwardRequestHeaders, forwardResponseHeaders } from "./headers.js";
import type { CallLimiter } from "./limits.js";
import type { PrincipalCache, Resolution } from "./principals.js";
import { classify, forwardedQuery, type Route, type RouteKind } from "./routes.js";
import type { CallContext, CallGate, UsageSink } from "./seams.js";

/**
 * The model gateway shim (KOBE-40, spec D30; principle 2 "secrets never enter the sandbox"). The
 * only way a sandbox reaches a model:
 *
 * 1. the sandbox's `kobe.model-gateway` session token (HS256 pinned, own key; other audiences'
 *    tokens fail) in any header a model SDK uses for its API key;
 * 2. an inference path (routes.ts) — never Bifrost's admin API;
 * 3. the token's member and sandbox still live (principals.ts; cached ≤ a few seconds);
 * 4. optional run attribution (`x-kobe-run-id`, must be leased to this sandbox);
 * 5. concurrency limits and the {@link CallGate} seam (KOBE-42);
 * 6. forwarded to Bifrost with only allowlisted headers plus `x-bf-vk: <member's virtual key>`,
 *    so Bifrost applies that member's team model allowlist (and, with KOBE-42, budgets);
 * 7. the response streamed back unbuffered; a client that goes away cancels the upstream call.
 */
export interface GatewayOptions {
  readonly verify: (token: string) => SessionTokenClaims;
  readonly principals: PrincipalCache;
  /** Whether `runId` is leased to `sandboxId` in `teamId` (KOBE-24 leases). */
  readonly isRunLeased: (teamId: string, runId: string, sandboxId: string) => Promise<boolean>;
  readonly bifrostUrl: string;
  readonly limiter: CallLimiter;
  readonly gate: CallGate;
  readonly sink: UsageSink;
  /** Bifrost refused a virtual key Kobe holds: ask the sync to re-push (NOTIFY `resync`). */
  readonly onBifrostForgotKey: () => void;
  readonly logger: Logger;
  readonly settings: { readonly maxBodyBytes: number; readonly idleTimeoutMs: number };
  readonly ready: () => boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bifrost's error types meaning "this virtual key does not exist here". */
const KEY_UNKNOWN = new Set(["access_not_found", "virtual_key_required"]);
const GEMINI_STATUS: Readonly<Record<number, string>> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  413: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED",
  503: "UNAVAILABLE",
};

/** An error in the shape the route's SDK parses (so Pi shows the message). */
function sendError(
  res: ServerResponse,
  kind: RouteKind,
  status: number,
  code: string,
  message: string,
  retryAfterSeconds?: number,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body =
    kind === "anthropic"
      ? { type: "error", error: { type: code, message } }
      : kind === "gemini"
        ? { error: { code: status, message, status: GEMINI_STATUS[status] ?? "UNKNOWN" } }
        : { error: { message, type: code, code } };
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...(retryAfterSeconds !== undefined ? { "retry-after": String(retryAfterSeconds) } : {}),
  });
  res.end(payload);
}

/** The model a request names: body `model` (OpenAI, Anthropic) or Gemini's path. */
function requestedModel(route: Route, body: Buffer): string | undefined {
  if (route.pathModel) return route.pathModel;
  const head = body.subarray(0, 65_536).toString("utf8");
  return /"model"\s*:\s*"([^"\\]{1,200})"/.exec(head)?.[1];
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) {
      resolve("too_large");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.pause();
        resolve("too_large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const REASONS: Readonly<
  Record<Exclude<Resolution, { ok: true }>["reason"], [number, string, string]>
> = {
  not_member: [401, "session_revoked", "This sandbox's user is no longer a member of the team."],
  sandbox_revoked: [401, "session_revoked", "This sandbox's session has been revoked."],
  no_key: [503, "model_access_pending", "Model access for this user is being set up; retry."],
  key_unreadable: [503, "model_access_unavailable", "Model access is unavailable; retry later."],
};

export function createModelGateway(options: GatewayOptions): Server {
  const { logger, settings } = options;
  const target = new URL(options.bifrostUrl);
  const secure = target.protocol === "https:";
  const send = secure ? httpsRequest : httpRequest;
  const agent = secure
    ? new HttpsAgent({ keepAlive: true, maxSockets: 256 })
    : new HttpAgent({ keepAlive: true, maxSockets: 256 });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    if (url.pathname === "/healthz" && req.method === "GET") {
      const ready = options.ready();
      res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: ready ? "ok" : "draining", service: "model-gateway" }));
      return;
    }
    const route = classify(req.method ?? "", url.pathname);
    const kind = route?.kind ?? "openai";

    // 1. The session token (any SDK's API-key header). No route detail before authentication.
    const credential = extractCredential(req.headers, url.searchParams);
    if (!credential.ok) {
      sendError(
        res,
        kind,
        401,
        "invalid_session_token",
        "A valid sandbox session token is required.",
      );
      return;
    }
    let claims: SessionTokenClaims;
    try {
      claims = options.verify(credential.token);
    } catch (err) {
      if (!(err instanceof SessionTokenError)) throw err;
      sendError(
        res,
        kind,
        401,
        "invalid_session_token",
        "A valid sandbox session token is required.",
      );
      return;
    }
    // 2. Inference paths only.
    if (!route) {
      sendError(res, kind, 404, "not_found", "Not a model inference endpoint.");
      return;
    }
    const identity = { teamId: claims.team_id, userId: claims.user_id, sandboxId: claims.sub };

    // 3. Liveness and the member's virtual key.
    let resolution = await options.principals.resolve(
      identity.teamId,
      identity.userId,
      identity.sandboxId,
    );
    if (!resolution.ok) {
      const [status, code, message] = REASONS[resolution.reason];
      if (status === 401) {
        logger.info({ ...identity, reason: resolution.reason }, "refused a revoked session token");
      }
      sendError(res, kind, status, code, message, status === 503 ? 5 : undefined);
      return;
    }

    // 4. Run attribution (optional header; when sent, it must be this sandbox's run).
    const runHeader = req.headers["x-kobe-run-id"];
    let runId: string | undefined;
    if (runHeader !== undefined) {
      if (typeof runHeader !== "string" || !UUID.test(runHeader)) {
        sendError(res, kind, 400, "invalid_run_id", "x-kobe-run-id must be a run id.");
        return;
      }
      runId = runHeader.toLowerCase();
      if (!(await options.isRunLeased(identity.teamId, runId, identity.sandboxId))) {
        sendError(res, kind, 403, "run_not_leased", "That run does not belong to this sandbox.");
        return;
      }
    }

    // 5. Limits, then the body (bounded), then the gate.
    const release = options.limiter.acquire(identity.sandboxId);
    if (!release) {
      sendError(res, kind, 429, "too_many_concurrent_calls", "Too many concurrent model calls.", 1);
      return;
    }
    const started = Date.now();
    let bytesIn = 0;
    let bytesOut = 0;
    let status = 0;
    let errorType: string | undefined;
    let aborted = false;
    let call: CallContext | undefined;
    try {
      const body = await readBody(req, settings.maxBodyBytes);
      if (body === "too_large") {
        res.setHeader("connection", "close");
        sendError(res, kind, 413, "request_too_large", "The request body is too large.");
        status = 413;
        return;
      }
      bytesIn = body.length;
      call = {
        ...identity,
        runId,
        route: route.kind,
        path: route.path,
        model: requestedModel(route, body),
      };
      const decision = await options.gate.admit(call);
      if (!decision.ok) {
        status = decision.status;
        sendError(
          res,
          kind,
          decision.status,
          decision.code,
          decision.message,
          decision.retryAfterSeconds,
        );
        return;
      }

      // 6.–7. Forward; retry once if Bifrost no longer knows the virtual key (restarted, resynced).
      const path = `${route.path}${forwardedQuery(url.searchParams)}`;
      for (let attempt = 0; ; attempt++) {
        const outcome = await forward(req, res, path, body, resolution.virtualKey, attempt === 0);
        status = outcome.status;
        errorType = outcome.errorType;
        bytesOut = outcome.bytesOut;
        aborted = outcome.aborted;
        if (outcome.kind !== "key_unknown") return;
        options.onBifrostForgotKey();
        const fresh = await options.principals.resolve(
          identity.teamId,
          identity.userId,
          identity.sandboxId,
          true,
        );
        if (attempt === 0 && fresh.ok && fresh.virtualKey !== resolution.virtualKey) {
          resolution = fresh;
          continue;
        }
        status = 503;
        sendError(
          res,
          kind,
          503,
          "model_gateway_resyncing",
          "The model gateway is resyncing; retry.",
          2,
        );
        return;
      }
    } finally {
      release();
      if (call) {
        options.sink.record({
          ...call,
          status,
          durationMs: Date.now() - started,
          bytesIn,
          bytesOut,
          errorType,
          aborted,
        });
      }
    }
  }

  type Outcome = {
    readonly kind: "done" | "key_unknown";
    readonly status: number;
    readonly errorType: string | undefined;
    readonly bytesOut: number;
    readonly aborted: boolean;
  };

  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    body: Buffer,
    virtualKey: string,
    mayRetry: boolean,
  ): Promise<Outcome> {
    return new Promise((resolve) => {
      let bytesOut = 0;
      let settled = false;
      const done = (o: Omit<Outcome, "bytesOut">) => {
        if (settled) return;
        settled = true;
        resolve({ ...o, bytesOut });
      };
      const upstream = send(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (secure ? 443 : 80),
          method: req.method,
          path,
          agent,
          headers: forwardRequestHeaders(req.headers, virtualKey, body.length),
        },
        (up) => {
          const upStatus = up.statusCode ?? 502;
          const small = upStatus >= 400 && Number(up.headers["content-length"] ?? 0) <= 65_536;
          if (upStatus >= 400 && small) {
            // Buffer error bodies (small): read Bifrost's error type; spot a forgotten key.
            const chunks: Buffer[] = [];
            up.on("data", (c: Buffer) => chunks.push(c));
            up.on("end", () => {
              const text = Buffer.concat(chunks);
              let type: string | undefined;
              try {
                const parsed = JSON.parse(text.toString("utf8")) as { type?: unknown };
                type = typeof parsed.type === "string" ? parsed.type : undefined;
              } catch {
                type = undefined;
              }
              if (mayRetry && upStatus === 401 && type && KEY_UNKNOWN.has(type)) {
                done({ kind: "key_unknown", status: upStatus, errorType: type, aborted: false });
                return;
              }
              if (!res.headersSent) {
                res.writeHead(upStatus, {
                  ...forwardResponseHeaders(up.headers),
                  "content-length": text.length,
                });
              }
              bytesOut = text.length;
              res.end(text);
              done({ kind: "done", status: upStatus, errorType: type, aborted: false });
            });
            up.on("error", () =>
              done({ kind: "done", status: upStatus, errorType: undefined, aborted: true }),
            );
            return;
          }
          res.writeHead(upStatus, forwardResponseHeaders(up.headers));
          res.flushHeaders();
          up.on("data", (chunk: Buffer) => {
            bytesOut += chunk.length;
            if (!res.write(chunk)) up.pause();
          });
          res.on("drain", () => up.resume());
          up.on("end", () => {
            res.end();
            done({ kind: "done", status: upStatus, errorType: undefined, aborted: false });
          });
          up.on("error", () => {
            res.destroy();
            done({ kind: "done", status: upStatus, errorType: undefined, aborted: true });
          });
        },
      );
      upstream.setTimeout(settings.idleTimeoutMs, () => upstream.destroy(new Error("idle")));
      upstream.on("error", (err) => {
        if (settled) return;
        if (!res.headersSent) {
          logger.warn({ err: err.message }, "bifrost unreachable");
          sendError(
            res,
            "openai",
            502,
            "model_gateway_unavailable",
            "The model gateway is unavailable.",
          );
          done({ kind: "done", status: 502, errorType: undefined, aborted: false });
        } else {
          res.destroy();
          done({ kind: "done", status: res.statusCode, errorType: undefined, aborted: true });
        }
      });
      // The sandbox went away: cancel the upstream call (Bifrost cancels the provider request).
      res.on("close", () => {
        if (!res.writableFinished) {
          upstream.destroy();
          done({ kind: "done", status: res.statusCode, errorType: undefined, aborted: true });
        }
      });
      upstream.end(body);
    });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      logger.error({ err }, "model gateway request failed");
      if (!res.headersSent) sendError(res, "openai", 500, "internal_error", "Internal error.");
      else res.destroy();
    });
  });
  // Slow-loris bounds: headers within 10 s, the request body within 2 minutes; responses
  // (streams) are bounded by the upstream idle timeout instead.
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.on("close", () => agent.destroy());
  return server;
}
