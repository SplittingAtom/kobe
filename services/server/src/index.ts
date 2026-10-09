import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import { approvalKeyring } from "./approvals/index.js";
import { isolationAuditor } from "./audit/isolation.js";
import { AUDIT_FORWARD_LOCK, AuditForwarder } from "./audit/forward/forwarder.js";
import { destinationsOf, sinksFor } from "./audit/forward/index.js";
import { AuditPiiSweeper } from "./audit/pii-sweeper.js";
import { BreakGlassSweeper } from "./break-glass/sweeper.js";
import { initTelemetry, loadTelemetryConfig } from "@kobe/telemetry";
import { loadConfig } from "./config.js";
import { loadConnectorUrlPolicy } from "./connectors/config.js";
import { createProxyProbe, PROBE_TIMEOUT_MS } from "./connectors/probe.js";
import { notifyDrift } from "./connectors/drift-notify.js";
import { CONNECTOR_REFRESH_LOCK, startConnectorRefresh } from "./connectors/refresh.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { EgressBlockedRelay } from "./egress/blocked-relay.js";
import { loadEgressHeaderSecrets } from "./egress/config.js";
import { resealTeamHeaders } from "./egress/header-store.js";
import { EgressRequestSweeper } from "./egress/request-notify.js";
import { EvalRunner } from "./agents/eval/service.js";
import { createIsolationGate } from "./isolation/gate.js";
import { listRuntimeClasses } from "./isolation/kubernetes.js";
import { logger } from "./logger.js";
import { createSmtpMailer } from "./mail/mailer.js";
import { createHttpBifrostAdmin } from "./models/bifrost-admin.js";
import { loadModelsConfig } from "./models/config.js";
import { ModelGatewaySync } from "./models/sync.js";
import { OFFBOARDING_SWEEP_LOCK } from "./offboarding/index.js";
import { createPgReconcileLock } from "./sandbox/reconcile-lock.js";
import { RetentionJob } from "./retention/job.js";
import { createInternalApp } from "./routes/internal.js";
import { createSandboxApp } from "./routes/sandbox.js";
import { createSandboxRuntime } from "./sandbox/runtime.js";
import { skillSandboxRoutes } from "./skills/sandbox-routes.js";
import { runTokenKeyFromEnv } from "./sandbox-wire/run-token.js";
import { providerLiveness, sandboxWireVerifier } from "./sandbox-wire/provider-auth.js";
import { createDeferredWaker, createSandboxLifecycle } from "./sandbox-lifecycle/index.js";
import {
  KEY_FINGERPRINT_PURPOSE,
  PROVIDER_KEY_PURPOSE,
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  deriveKey,
  loadEnvelope,
} from "@kobe/db";
import { quantityBytes } from "./sandbox/config.js";
import {
  createS3ObjectStore,
  createSandboxAuthenticator,
  createWorkspaceSync,
  loadS3Settings,
} from "./workspace-sync/index.js";

/** Open streams (SSE) get this long to finish before being cut; stays under k8s' 30 s grace period. */
const EVAL_SWEEP_MS = 60_000;
const OFFBOARDING_SWEEP_MS = 10 * 60_000;
const DRAIN_TIMEOUT_MS = 10_000;

const config = loadConfig(process.env);
const telemetry = initTelemetry(loadTelemetryConfig(process.env, config.process));
// Object storage (s3.*): workspace sync (KOBE-27), thread export and retention (KOBE-18).
const s3 = loadS3Settings(process.env);
const objectStore = s3 ? createS3ObjectStore(s3) : undefined;
// Model gateway (KOBE-40): undefined without the chart's Bifrost settings (models off).
const modelsConfig = config.process === "server" ? loadModelsConfig(process.env) : undefined;
// Header injection (KOBE-39): undefined without the chart's header secret (off).
const egressHeaderSecrets =
  config.process === "server" ? loadEgressHeaderSecrets(process.env) : undefined;
// Install envelope key (KOBE-107): seals per-record secrets (connector credentials, KOBE-108).
// Fails fast when malformed; the key itself is never logged.
const envelope = config.process === "server" ? loadEnvelope(process.env, logger) : undefined;
// One admin client for the config sync and the catalog editor's model listing (KOBE-44).
const bifrostAdmin = modelsConfig
  ? createHttpBifrostAdmin({
      baseUrl: modelsConfig.bifrostUrl,
      username: modelsConfig.adminUsername,
      password: modelsConfig.adminPassword,
    })
  : undefined;
// Run-bound model-gateway tokens (KOBE-118): keyed from the gateway session key; unset: off.
const runTokenKey = runTokenKeyFromEnv(process.env);
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
    sandboxWire: { waker, ...(runTokenKey ? { runTokenKey } : {}) },
    connectors: loadConnectorUrlPolicy(process.env),
    auditForwardingDestinations: destinationsOf(config.auditForwarding),
    ...(config.mcpProxyUrl && config.mcpProxyInternalKey
      ? {
          connectorProbe: createProxyProbe({
            baseUrl: config.mcpProxyUrl,
            internalKey: config.mcpProxyInternalKey,
            timeoutMs: PROBE_TIMEOUT_MS,
          }),
        }
      : {}),
    agents: { maxVersions: config.agentMaxVersions },
    ...(egressHeaderSecrets ? { egressHeaderSecrets } : {}),
    ...(envelope ? { envelope } : {}),
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

// Gallery agents come from definitions in the repo (KOBE-87): seeded at every start, so install and
// upgrade alike. Idempotent; a failure is logged and never stops the server from starting.
if (deps && config.process === "server") {
  await seedGalleryAgents(deps.database.db).catch((err: unknown) =>
    logger.error({ err }, "gallery agents could not be seeded"),
  );
}

// Spec D4: the process's own isolation check (startup + periodic). Agent work must go through
// isolation.require(); without a verified gVisor/Kata RuntimeClass the server keeps serving.
const auditIsolation = deps ? isolationAuditor(deps.database.db) : undefined;
const isolation = createIsolationGate({
  runtimeClassName: config.runtimeClassName,
  listRuntimeClasses,
  // A transient API failure at boot is retried before the pod can turn ready (KOBE-125).
  startupAttempts: 5,
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
// Optional SIEM forwarding (syslog, OTLP; KOBE-19): a sweep, one replica forwards at a time.
const auditForwarder =
  deps && destinationsOf(config.auditForwarding).length > 0
    ? new AuditForwarder({
        db: deps.database.db,
        sinks: sinksFor(config.auditForwarding),
        lock: createPgReconcileLock(
          deps.database.pool,
          (err) => logger.warn({ err }, "audit forwarding lock connection problem"),
          AUDIT_FORWARD_LOCK,
        ),
        log: logger,
      })
    : undefined;
auditForwarder?.start();
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
// Budgets: spend hints from the model gateway and a sweep over every team (KOBE-42).
deps?.budgets.start();
isolation.start().catch((err: unknown) => logger.error({ err }, "isolation check failed"));

// Blocked egress attempts → `egress.blocked` run events (KOBE-38); every server replica listens.
const egressRelay =
  deps && config.process === "server"
    ? new EgressBlockedRelay({ db: deps.database.db, connectionString: config.databaseUrl })
    : undefined;
egressRelay?.start();
// Request-access emails (KOBE-39): retries and anything a crashed replica left queued.
const egressRequestSweeper =
  deps && config.process === "server" ? new EgressRequestSweeper(deps) : undefined;
egressRequestSweeper?.start();
// Header values sealed with a previous header secret are re-sealed with the current one (rotation).
if (deps?.egressHeaders && config.process === "server") {
  const box = deps.egressHeaders;
  resealTeamHeaders(deps.database.db, box)
    .then((n) => {
      if (n > 0)
        logger.info({ domains: n }, "egress header values re-sealed with the current secret");
    })
    .catch((err: unknown) => logger.error({ err }, "egress header re-seal failed"));
}

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
if (config.process === "server" && !egressHeaderSecrets) {
  logger.warn("KOBE_EGRESS_HEADER_SECRET is not set: egress header injection is off");
}
if (config.process === "server" && !envelope) {
  logger.warn("KOBE_ENVELOPE_KEY is not set: connector credentials cannot be stored");
}
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
// One caller check for every sandbox-listener HTTP endpoint (workspace sync, skill bundles).
const sandboxAuth = sandbox && deps ? workspaceAuth(deps, sandbox) : undefined;
const stopCollector = workspaceSync?.startCollector((syncSettings?.collectSeconds ?? 3600) * 1000);

// Pre-publish Orbit evals (KOBE-93): Jobs in team namespaces, through the sandbox provider.
const evalRunner =
  sandbox && deps
    ? new EvalRunner({
        db: deps.database.db,
        kube: sandbox.kube,
        provider: sandbox.provider,
        isolation,
        settings: sandbox.settings,
        sessionKeys: sandbox.sessionKeys,
        limits: { maxVersions: deps.agentLimits.maxVersions },
      })
    : undefined;

// The scheduler serves health endpoints only (its jobs arrive in KOBE-64).
const server = serve(
  {
    fetch: createApp(deps, { isolation, ...(evalRunner ? { evals: evalRunner } : {}) }).fetch,
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
          ...(workspaceSync && sandboxAuth ? { workspace: workspaceSync.routes(sandboxAuth) } : {}),
          // Skill bundles (KOBE-82): served from the same object store, to live sandboxes only.
          ...(deps?.blobs && sandboxAuth
            ? {
                skills: skillSandboxRoutes({
                  db: deps.database.db,
                  blobs: deps.blobs,
                  authenticate: sandboxAuth,
                  log: logger,
                }),
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
if (sandbox && deps) deps.offboarding.setProvider(sandbox.provider);
const lifecycle =
  sandbox && deps
    ? createSandboxLifecycle({
        db: deps.database.db,
        provider: sandbox.provider,
        idleMinutes: sandbox.settings.hibernation.idleMinutes,
        // A returning member's offboarded sandbox is replaced by a new one (KOBE-28, D12).
        reinstate: (target) => deps.offboarding.reinstate(target),
      })
    : undefined;
if (lifecycle) waker.set(lifecycle.waker);
// Team namespaces follow the server version (KOBE-115): reconciled at start and on an interval,
// one replica at a time. Awake sandboxes under changed NetworkPolicies are flagged, not killed.
const stopTeamReconciler =
  sandbox && deps
    ? sandbox.startTeamReconciler({
        lock: createPgReconcileLock(deps.database.pool, (err) =>
          logger.warn({ err }, "team reconcile lock connection problem"),
        ),
        intervalMs: config.teamReconcileSeconds * 1000,
        onSummary: (s) => {
          const { policyChanged, ...counts } = s;
          logger.info(
            { ...counts, policyChanged: policyChanged.length },
            "team namespaces reconciled",
          );
          if (policyChanged.length > 0) {
            logger.warn(
              { namespaces: policyChanged },
              "team namespace NetworkPolicies changed: sandboxes already running there keep their pods but now run under the new rules",
            );
          }
        },
      })
    : undefined;
// Offboarding (KOBE-28, D12): finishes departures that were missed, deletes volumes and workspace
// copies 30 days after the member left (never under a legal hold). One replica at a time.
const stopOffboarding =
  deps && config.process === "server"
    ? deps.offboarding.start({
        lock: createPgReconcileLock(
          deps.database.pool,
          (err) => logger.warn({ err }, "offboarding sweep lock connection problem"),
          OFFBOARDING_SWEEP_LOCK,
        ),
        everyMs: OFFBOARDING_SWEEP_MS,
      })
    : undefined;
// Connector tool drift (KOBE-102, D27): re-probe pinned connectors; changed/new tools are disabled
// until an install admin re-approves them. One replica at a time.
const stopConnectorRefresh =
  deps && config.process === "server"
    ? startConnectorRefresh({
        db: deps.database.db,
        prober: deps.connectorProbe,
        lock: createPgReconcileLock(
          deps.database.pool,
          (err) => logger.warn({ err }, "connector refresh lock connection problem"),
          CONNECTOR_REFRESH_LOCK,
        ),
        intervalMs: config.connectorRefreshSeconds * 1000,
        logger,
        afterPass: () =>
          notifyDrift({ db: deps.database.db, mailer: deps.mailer, publicUrl: deps.publicUrl }),
      })
    : undefined;
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

// Evals whose driver died with a server (restart mid-eval) are finished or errored by any replica.
const evalSweep = evalRunner
  ? setInterval(() => {
      evalRunner.sweep().catch((err: unknown) => logger.warn({ err }, "orbit eval sweep failed"));
    }, EVAL_SWEEP_MS)
  : undefined;
evalSweep?.unref();

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  isolation.stop();
  stopReconciler?.();
  stopTeamReconciler?.();
  stopOffboarding?.();
  stopConnectorRefresh?.();
  if (evalSweep) clearInterval(evalSweep);
  stopHibernation?.();
  stopCollector?.();
  sandboxServer?.close();
  internalServer?.close();
  deps?.auditAnchor.stop();
  void egressRelay?.close();
  egressRequestSweeper?.stop();
  void modelSync?.close();
  breakGlassSweeper?.stop();
  auditPiiSweeper?.stop();
  auditForwarder?.stop();
  void retentionJob?.stop();
  deps?.approvals.stop();
  // End event streams first so browsers reconnect (with Last-Event-ID) to another replica.
  void deps?.eventStream.hub.close();
  server.close((err) => {
    if (err) logger.error({ err }, "shutdown error");
    void Promise.all([deps?.close(), telemetry.shutdown()]).finally(() =>
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
