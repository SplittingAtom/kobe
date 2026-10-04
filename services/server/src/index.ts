import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { approvalKeyring } from "./approvals/index.js";
import { isolationAuditor } from "./audit/isolation.js";
import { AuditPiiSweeper } from "./audit/pii-sweeper.js";
import { BreakGlassSweeper } from "./break-glass/sweeper.js";
import { loadConfig } from "./config.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { EgressBlockedRelay } from "./egress/blocked-relay.js";
import { createIsolationGate } from "./isolation/gate.js";
import { listRuntimeClasses } from "./isolation/kubernetes.js";
import { logger } from "./logger.js";
import { createSmtpMailer } from "./mail/mailer.js";
import { createHttpBifrostAdmin } from "./models/bifrost-admin.js";
import { loadModelsConfig } from "./models/config.js";
import { ModelGatewaySync } from "./models/sync.js";
import { RetentionJob } from "./retention/job.js";
import { createInternalApp } from "./routes/internal.js";
import { createSandboxApp } from "./routes/sandbox.js";
import { createSandboxRuntime } from "./sandbox/runtime.js";
import { providerLiveness, sandboxWireVerifier } from "./sandbox-wire/provider-auth.js";
import { createDeferredWaker, createSandboxLifecycle } from "./sandbox-lifecycle/index.js";
import {
  KEY_FINGERPRINT_PURPOSE,
  PROVIDER_KEY_PURPOSE,
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  deriveKey,
} from "@kobe/db";
import { quantityBytes } from "./sandbox/config.js";
import {
  createS3ObjectStore,
  createSandboxAuthenticator,
  createWorkspaceSync,
  loadS3Settings,
} from "./workspace-sync/index.js";

/** Open streams (SSE) get this long to finish before being cut; stays under k8s' 30 s grace period. */
const DRAIN_TIMEOUT_MS = 10_000;

const config = loadConfig(process.env);
// Object storage (s3.*): workspace sync (KOBE-27), thread export and retention (KOBE-18).
const s3 = loadS3Settings(process.env);
const objectStore = s3 ? createS3ObjectStore(s3) : undefined;
// Model gateway (KOBE-40): undefined without the chart's Bifrost settings (models off).
const modelsConfig = config.process === "server" ? loadModelsConfig(process.env) : undefined;
// One admin client for the config sync and the catalog editor's model listing (KOBE-44).
const bifrostAdmin = modelsConfig
  ? createHttpBifrostAdmin({
      baseUrl: modelsConfig.bifrostUrl,
      username: modelsConfig.adminUsername,
      password: modelsConfig.adminPassword,
    })
  : undefined;
// The wire is built before the sandbox provider exists: its waker is set once the provider is.
const waker = createDeferredWaker();
let deps: ServerDeps | undefined;
if (config.auth && config.smtp) {
  const { approvalKey, ...auth } = config.auth;
  deps = createServerDeps({
    databaseUrl: config.databaseUrl,
    ...auth,
    ...(approvalKey ? { approvalKeys: approvalKeyring(approvalKey) } : {}),
    mailer: createSmtpMailer(config.smtp),
    sandboxWire: { waker },
    agents: { maxVersions: config.agentMaxVersions },
    ...(s3 && objectStore ? { blobs: { objects: objectStore, prefix: s3.prefix } } : {}),
    ...(modelsConfig
      ? {
          models: {
            providerKeySecrets: modelsConfig.providerKeySecrets,
            allowUnsafeEndpoints: modelsConfig.allowUnsafeEndpoints,
            ...(bifrostAdmin ? { discovery: bifrostAdmin } : {}),
          },
        }
      : {}),
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
// Audit rows lose their client IP and user agent after the retention period (KOBE-17).
const auditPiiSweeper = deps ? new AuditPiiSweeper(deps.database.db) : undefined;
auditPiiSweeper?.start();
// Nightly retention (KOBE-18, D18): Trash and retention purges, run_events compaction, released
// blobs. Every replica checks; an advisory lock lets one run a pass.
const retentionJob = deps
  ? new RetentionJob({
      db: deps.database.db,
      pool: deps.database.pool,
      blobs: deps.blobs,
      hourUtc: config.retentionHourUtc,
      logger,
    })
  : undefined;
retentionJob?.start();
// Pending approvals past their 1 h TTL whose waiting replica is gone (D29, KOBE-37).
deps?.approvals.start();
isolation.start().catch((err: unknown) => logger.error({ err }, "isolation check failed"));

// Blocked egress attempts → `egress.blocked` run events (KOBE-38); every server replica listens.
const egressRelay =
  deps && config.process === "server"
    ? new EgressBlockedRelay({ db: deps.database.db, connectionString: config.databaseUrl })
    : undefined;
egressRelay?.start();

// Bifrost config sync (KOBE-40): every server replica listens; one leads and reconciles.
const modelSync =
  deps && modelsConfig && bifrostAdmin
    ? new ModelGatewaySync({
        db: deps.database.db,
        connectionString: config.databaseUrl,
        admin: bifrostAdmin,
        providerKeys: new SecretBox(modelsConfig.providerKeySecrets, PROVIDER_KEY_PURPOSE),
        virtualKeys: new SecretBox(modelsConfig.virtualKeySecrets, VIRTUAL_KEY_PURPOSE),
        // Own HKDF purpose: the fingerprint secret never equals a sealing key.
        fingerprintSecret: deriveKey(
          modelsConfig.providerKeySecrets[0] ?? "",
          KEY_FINGERPRINT_PURPOSE,
        ).toString("hex"),
        intervalMs: modelsConfig.syncIntervalMs,
        logger,
      })
    : undefined;
modelSync?.start();
if (config.process === "server" && !modelsConfig) {
  logger.warn("KOBE_BIFROST_URL is not set: the model gateway is not configured");
}

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

// Workspace sync (KOBE-27): /workspace ↔ S3, brokered by the server on the sandbox listener so
// sandboxes never hold object-store credentials. Off without a bucket (s3.bucket) or when disabled.
const syncSettings = sandbox?.settings.workspaceSync;
const workspaceSync =
  sandbox && deps && s3 && objectStore && syncSettings?.enabled
    ? createWorkspaceSync({
        db: deps.database.db,
        objects: objectStore,
        prefix: s3.prefix,
        limits: {
          maxFileBytes: quantityBytes(syncSettings.maxFileSize),
          maxWorkspaceBytes: quantityBytes(
            syncSettings.maxWorkspaceSize ?? sandbox.settings.workspace.size,
          ),
          maxFiles: syncSettings.maxFiles,
        },
        log: logger,
      })
    : undefined;
if (sandbox && syncSettings?.enabled && !s3) {
  logger.warn("object storage is not configured (s3.bucket): workspace sync is off");
}
/** Workspace sync's caller checks; revocations (deactivation, removal) clear its cache. */
function workspaceAuth(d: ServerDeps, s: NonNullable<typeof sandbox>) {
  const authenticate = createSandboxAuthenticator({
    db: d.database.db,
    verify: sandboxWireVerifier(s.sessionKeys),
    // Short positive cache: a destroyed or replaced sandbox loses access within 5 s.
    liveness: providerLiveness(s.provider, d.database.db, 5_000),
  });
  d.sandboxWire.onUserRevalidate((userId) => authenticate.forget(userId));
  return authenticate;
}
const stopCollector = workspaceSync?.startCollector((syncSettings?.collectSeconds ?? 3600) * 1000);

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
        fetch: createSandboxApp({
          ...sandbox,
          ...(workspaceSync && deps
            ? {
                workspace: workspaceSync.routes(workspaceAuth(deps, sandbox)),
              }
            : {}),
        }).fetch,
        port: sandbox.settings.endpoints.server.targetPort,
        // Workspace uploads (KOBE-27) may take a while: up to 1 GiB per file.
        serverOptions: { requestTimeout: 60 * 60_000 },
      },
      (info) => logger.info({ port: info.port }, "sandbox listener"),
    )
  : undefined;
// The sandbox wire (KOBE-24) on the sandbox listener only — never on the user-facing app.
const liveness = sandbox && deps ? providerLiveness(sandbox.provider, deps.database.db) : undefined;
if (sandbox && sandboxServer && deps && liveness) {
  deps.sandboxWire.attach(sandboxServer as Server, {
    verify: sandboxWireVerifier(sandbox.sessionKeys),
    liveness,
  });
}
// Internal listener (KOBE-58): the MCP proxy's policy re-check. Its own port, admitted by the
// release NetworkPolicy from the MCP proxy only, and keyed (routes/internal.ts).
const internalServer =
  sandbox && deps && liveness && config.mcpProxyInternalKey
    ? serve(
        {
          fetch: createInternalApp({
            internalKey: config.mcpProxyInternalKey,
            mcp: deps.mcp,
            auth: {
              db: deps.database.db,
              sessionKey: sandbox.sessionKeys["kobe.mcp-proxy"],
              liveness,
            },
          }).fetch,
          port: config.internalPort,
        },
        (info) => logger.info({ port: info.port }, "internal listener"),
      )
    : undefined;
if (sandbox && deps && !config.mcpProxyInternalKey) {
  logger.error(
    "KOBE_MCP_PROXY_INTERNAL_KEY is not set: MCP calls are refused (install with the chart)",
  );
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
  stopCollector?.();
  sandboxServer?.close();
  internalServer?.close();
  deps?.auditAnchor.stop();
  void egressRelay?.close();
  void modelSync?.close();
  breakGlassSweeper?.stop();
  auditPiiSweeper?.stop();
  void retentionJob?.stop();
  deps?.approvals.stop();
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
