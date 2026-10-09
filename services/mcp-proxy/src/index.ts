import { serve } from "@hono/node-server";
import { initTelemetry, loadTelemetryConfig } from "@kobe/telemetry";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createServerCredentials } from "./credentials.js";
import { createLimiter } from "./limits.js";
import { logger } from "./logger.js";
import { createPolicyServer } from "./server-client.js";
import { createUpstreamClient } from "./upstream.js";

/** Open streams get this long to finish before being cut; stays under k8s' 30 s grace period. */
const DRAIN_TIMEOUT_MS = 10_000;

const config = loadConfig(process.env);
const telemetry = initTelemetry(loadTelemetryConfig(process.env, "mcp-proxy"));
const upstream = createUpstreamClient({
  policy: config.upstream,
  maxResponseBytes: config.limits.maxResponseBytes,
});
const policyServer = createPolicyServer({
  baseUrl: config.serverUrl,
  internalKey: config.internalKey,
  timeoutMs: config.limits.serverTimeoutMs,
  onError: (err) => logger.warn({ err }, "policy server unavailable (call refused)"),
});
const app = createApp(
  {
    sessionKey: config.sessionKey,
    server: policyServer,
    upstream,
    // Per-user API-key grants from the server (KOBE-108); OAuth grants arrive with KOBE-61.
    credentials: createServerCredentials(policyServer),
    limiter: createLimiter({
      burst: config.limits.requestBurst,
      perSecond: config.limits.requestsPerSecond,
      callsPerSandbox: config.limits.callsPerSandbox,
      maxConcurrentCalls: config.limits.maxConcurrentCalls,
    }),
    limits: config.limits,
    log: logger,
  },
  {
    internalKey: config.internalKey,
    upstream,
    timeoutMs: config.limits.upstreamTimeoutMs,
    maxRequestBytes: 4 * 1024,
  },
);
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(
    {
      port: info.port,
      insecureHttp: config.upstream.allowInsecureHttp,
      ports: config.upstream.allowedPorts,
    },
    "listening",
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  server.close((err) => {
    if (err) logger.error({ err }, "shutdown error");
    void Promise.all([upstream.close(), telemetry.shutdown()]).finally(() =>
      process.exit(err ? 1 : 0),
    );
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    setTimeout(() => process.exit(1), 1_000).unref();
  }, DRAIN_TIMEOUT_MS).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
