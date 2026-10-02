import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createServerDeps } from "./deps.js";
import { logger } from "./logger.js";

/** Open streams (SSE) get this long to finish before being cut; stays under k8s' 30 s grace period. */
const DRAIN_TIMEOUT_MS = 10_000;

const config = loadConfig(process.env);
const deps = createServerDeps({
  databaseUrl: config.databaseUrl,
  publicUrl: config.publicUrl,
  authSecret: config.authSecret,
});
const server = serve({ fetch: createApp(deps).fetch, port: config.port }, (info) => {
  logger.info({ port: info.port, process: config.process }, "listening");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  server.close((err) => {
    if (err) logger.error({ err }, "shutdown error");
    void deps.close().finally(() => process.exit(err ? 1 : 0));
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    setTimeout(() => process.exit(1), 1_000).unref();
  }, DRAIN_TIMEOUT_MS).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
