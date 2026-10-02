import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { createIsolationGate } from "./isolation/gate.js";
import { listRuntimeClasses } from "./isolation/kubernetes.js";
import { logger } from "./logger.js";
import { createSandboxApp } from "./routes/sandbox.js";
import { createSandboxRuntime } from "./sandbox/runtime.js";

/** Open streams (SSE) get this long to finish before being cut; stays under k8s' 30 s grace period. */
const DRAIN_TIMEOUT_MS = 10_000;

const config = loadConfig(process.env);
let deps: ServerDeps | undefined;
if (config.auth) {
  deps = createServerDeps({ databaseUrl: config.databaseUrl, ...config.auth });
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
const isolation = createIsolationGate({
  runtimeClassName: config.runtimeClassName,
  listRuntimeClasses,
  onChange: (status) => {
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
isolation.start().catch((err: unknown) => logger.error({ err }, "isolation check failed"));

// Sandbox provider (KOBE-22); the scheduler starts sandboxes through it from KOBE-64 on.
const sandbox =
  config.process === "server" ? createSandboxRuntime(process.env, isolation) : undefined;
if (config.process === "server" && !sandbox) {
  logger.error(
    "KOBE_SANDBOX_CONFIG is not set: sandboxes are disabled (install with the Helm chart)",
  );
}

// The scheduler serves health endpoints only (its jobs arrive in KOBE-64).
const server = serve(
  {
    fetch: createApp(deps, { isolation }).fetch,
    port: config.port,
  },
  (info) => {
    logger.info({ port: info.port, process: config.process }, "listening");
  },
);

// Sandbox-facing listener: the only server port the sandbox NetworkPolicy allows (no user API).
const sandboxServer = sandbox
  ? serve(
      {
        fetch: createSandboxApp(sandbox).fetch,
        port: sandbox.settings.endpoints.server.targetPort,
      },
      (info) => logger.info({ port: info.port }, "sandbox listener"),
    )
  : undefined;
// Deletes sandbox pods found outside the verified isolation runtime (startup + every minute).
const stopReconciler = sandbox?.startReconciler((result) => {
  if (result.deleted.length > 0) {
    logger.error(
      { deleted: result.deleted, reason: result.reason },
      "deleted unverified sandbox pods",
    );
  }
});

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  isolation.stop();
  stopReconciler?.();
  sandboxServer?.close();
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
