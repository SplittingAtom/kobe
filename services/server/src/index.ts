import type { Server } from "node:http";
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
import { createSandboxApp } from "./routes/sandbox.js";
import { createSandboxRuntime } from "./sandbox/runtime.js";
import { providerLiveness, sandboxWireVerifier } from "./sandbox-wire/provider-auth.js";
import { createDeferredWaker, createSandboxLifecycle } from "./sandbox-lifecycle/index.js";

/** Open streams (SSE) get this long to finish before being cut; stays under k8s' 30 s grace period. */
const DRAIN_TIMEOUT_MS = 10_000;

const config = loadConfig(process.env);
// The wire is built before the sandbox provider exists: its waker is set once the provider is.
const waker = createDeferredWaker();
let deps: ServerDeps | undefined;
if (config.auth && config.smtp) {
  deps = createServerDeps({
    databaseUrl: config.databaseUrl,
    ...config.auth,
    mailer: createSmtpMailer(config.smtp),
    sandboxWire: { waker },
    agents: { maxVersions: config.agentMaxVersions },
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
// New runs are refused at once while the isolation runtime is missing (sandbox creation enforces
// it regardless through isolation.require()).
deps?.runs.useIsolation(() => {
  const { state } = isolation.status();
  return state === "verified" ? "available" : state;
});
// Audit chain head in the server log at startup and every 5 minutes (KOBE-15): ship it off the box.
deps?.auditAnchor.start();
// Break-glass grants end at expires_at on their own; this records the end and notifies (KOBE-16).
const breakGlassSweeper = deps ? new BreakGlassSweeper(deps) : undefined;
breakGlassSweeper?.start();
isolation.start().catch((err: unknown) => logger.error({ err }, "isolation check failed"));

// Sandbox provider (KOBE-22); the scheduler starts sandboxes through it from KOBE-64 on.
const sandbox =
  config.process === "server"
    ? createSandboxRuntime(process.env, isolation, deps?.database.db)
    : undefined;
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
// The sandbox wire (KOBE-24) on the sandbox listener only — never on the user-facing app.
if (sandbox && sandboxServer && deps) {
  deps.sandboxWire.attach(sandboxServer as Server, {
    verify: sandboxWireVerifier(sandbox.sessionKeys),
    liveness: providerLiveness(sandbox.provider, deps.database.db),
  });
}
// Hibernation and wake (KOBE-25, D14): the router wakes sandboxes it finds disconnected; every
// replica sweeps for idle ones (the sandboxes row lock keeps replicas from colliding).
const lifecycle =
  sandbox && deps
    ? createSandboxLifecycle({
        db: deps.database.db,
        provider: sandbox.provider,
        idleMinutes: sandbox.settings.hibernation.idleMinutes,
      })
    : undefined;
if (lifecycle) waker.set(lifecycle.waker);
const stopHibernation =
  lifecycle && sandbox?.settings.hibernation.enabled
    ? lifecycle.start(sandbox.settings.hibernation.sweepSeconds * 1000)
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
  stopHibernation?.();
  sandboxServer?.close();
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
