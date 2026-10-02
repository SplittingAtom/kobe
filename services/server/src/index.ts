import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { isolationAuditor } from "./audit/isolation.js";
import { BreakGlassSweeper } from "./break-glass/sweeper.js";
import { loadConfig } from "./config.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { createIsolationGate } from "./isolation/gate.js";
import { listRuntimeClasses } from "./isolation/kubernetes.js";
import { logger } from "./logger.js";
import { createSmtpMailer } from "./mail/mailer.js";

/** Open streams (SSE) get this long to finish before being cut; stays under k8s' 30 s grace period. */
const DRAIN_TIMEOUT_MS = 10_000;

const config = loadConfig(process.env);
let deps: ServerDeps | undefined;
if (config.auth && config.smtp) {
  deps = createServerDeps({
    databaseUrl: config.databaseUrl,
    ...config.auth,
    mailer: createSmtpMailer(config.smtp),
  });
  if (config.smtp.security === "none") {
    logger.warn(
      { smtpHost: config.smtp.host },
      "KOBE_SMTP_SECURITY=none: email is sent unencrypted",
    );
  }
  const publicHost = new URL(config.auth.publicUrl).hostname;
  if (
    config.auth.publicUrl.startsWith("http:") &&
    !/^(localhost|127\.0\.0\.1)$|\.localtest\.me$/.test(publicHost)
  ) {
    logger.warn(
      { publicUrl: config.auth.publicUrl },
      "KOBE_PUBLIC_URL is plain http: session cookies are not Secure and passkeys need https",
    );
  }
}

// Spec D4: the process's own isolation check (startup + periodic). Agent work must go through
// isolation.require(); without a verified gVisor/Kata RuntimeClass the server keeps serving.
const auditIsolation = deps ? isolationAuditor(deps.database.db) : undefined;
const isolation = createIsolationGate({
  runtimeClassName: config.runtimeClassName,
  listRuntimeClasses,
  onChange: (status) => {
    void auditIsolation?.(status);
    if (status.state === "verified") {
      logger.info(
        { runtimeClass: status.runtimeClassName, handler: status.handler },
        "isolation verified: agents enabled",
      );
    } else if (status.state === "missing") {
      logger.error({ runtimeClass: status.runtimeClassName }, `agents disabled: ${status.message}`);
    }
  },
});
// Audit chain head in the server log at startup and every 5 minutes (KOBE-15): ship it off the box.
deps?.auditAnchor.start();
// Break-glass grants end at expires_at on their own; this records the end and notifies (KOBE-16).
const breakGlassSweeper = deps ? new BreakGlassSweeper(deps) : undefined;
breakGlassSweeper?.start();
isolation.start().catch((err: unknown) => logger.error({ err }, "isolation check failed"));

// The scheduler serves health endpoints only (its jobs arrive in KOBE-64).
const server = serve({ fetch: createApp(deps, { isolation }).fetch, port: config.port }, (info) => {
  logger.info({ port: info.port, process: config.process }, "listening");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  isolation.stop();
  deps?.auditAnchor.stop();
  breakGlassSweeper?.stop();
  // End event streams first so browsers reconnect (with Last-Event-ID) to another replica.
  void deps?.eventStream.hub.close();
  server.close((err) => {
    if (err) logger.error({ err }, "shutdown error");
    void (deps?.close() ?? Promise.resolve()).finally(() => process.exit(err ? 1 : 0));
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    setTimeout(() => process.exit(1), 1_000).unref();
  }, DRAIN_TIMEOUT_MS).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
