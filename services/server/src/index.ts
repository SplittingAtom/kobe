import { createProxyAppCaller } from "./apps/app-caller.js";
import type { Server } from "node:http";
import { ExternalScanRunner } from "./skills/registry/external-scan.js";
import { egressProxyUrl, loadSkillMirrorConfig } from "./skills/mirror/config.js";
import { SKILL_MIRROR_SWEEP_MS, SkillMirror } from "./skills/mirror/runner.js";
import { mirrorHttpClient } from "./skills/mirror/http-client.js";
import { IMPORT_FETCH_MAX_BYTES } from "./skills/import/service.js";
import { signSiteEgressToken } from "@kobe/session-token";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { approvalKeyring } from "./approvals/index.js";
import { isolationAuditor } from "./audit/isolation.js";
import { destinationsOf } from "./audit/forward/index.js";
import { forwardingSecrets } from "./audit/forward/redact.js";
import { createLangfuseScoreSink, initTelemetry, loadTelemetryConfig } from "@kobe/telemetry";
import { loadConfig } from "./config.js";
import { seedAtStart, serverJobs, startServerJobs } from "./startup/jobs.js";
import { checkSealedKeys, sealedFamilies } from "./startup/sealed-keys.js";
import { loadConnectorUrlPolicy } from "./connectors/config.js";
import { createProxyProbe, PROBE_TIMEOUT_MS } from "./connectors/probe.js";
import { createServerDeps, type ServerDeps } from "./deps.js";
import { loadEgressHeaderSecrets } from "./egress/config.js";
import { deliverNotificationEmails } from "./notifications/email.js";
import { EvalRunner } from "./agents/eval/service.js";
import { createIsolationGate } from "./isolation/gate.js";
import { listRuntimeClasses } from "./isolation/kubernetes.js";
import { logger } from "./logger.js";
import { createSmtpMailer } from "./mail/mailer.js";
import { createHttpBifrostAdmin } from "./models/bifrost-admin.js";
import { loadModelsConfig } from "./models/config.js";
import { createPgReconcileLock } from "./sandbox/reconcile-lock.js";
import { loadUploadSettings } from "./uploads/settings.js";
import { createInternalApp } from "./routes/internal.js";
import { createSandboxApp } from "./routes/sandbox.js";
import { createSandboxRuntime } from "./sandbox/runtime.js";
import { schedulerAuthStandIn } from "./scheduler/process-deps.js";
import { onScheduledRunEnded } from "./scheduler/run-hook.js";
import { SchedulerRunner } from "./scheduler/runner.js";
import { skillSandboxRoutes } from "./skills/sandbox-routes.js";
import { skillEvalFixtureRoutes } from "./skills/evals/fixture-routes.js";
import { SkillEvalHub } from "./skills/evals/events.js";
import {
  reapSkillEvals,
  SKILL_EVAL_REAPER_LOCK,
  SKILL_EVAL_REAPER_MS,
} from "./skills/evals/reaper.js";
import { SkillEvalRunner } from "./skills/evals/runner.js";
import { runTokenKeyFromEnv, traceSpanKeyFromEnv } from "./sandbox-wire/run-token.js";
import { serverCallKeyFromEnv } from "./models/gateway-client.js";
import { providerLiveness, sandboxWireVerifier } from "./sandbox-wire/provider-auth.js";
import { createDeferredWaker, createSandboxLifecycle } from "./sandbox-lifecycle/index.js";
import {
  PROVIDER_KEY_PURPOSE,
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  headerBox,
  loadEnvelope,
} from "@kobe/db";
import { quantityBytes } from "./sandbox/config.js";
import { createViewingReader } from "./workspace-files/viewing.js";
import { createAttachmentStager } from "./uploads/attach.js";
import {
  createS3ObjectStore,
  createSandboxAuthenticator,
  createWorkspaceSync,
  loadS3Settings,
} from "./workspace-sync/index.js";

/** Open streams (SSE) get this long to finish before being cut; stays under k8s' 30 s grace period. */
const EVAL_SWEEP_MS = 60_000;
/** Skill eval runner sweep (KOBE-325): claims queued executions within each team's cap. */
const SKILL_EVAL_SWEEP_MS = 5_000;
const DRAIN_TIMEOUT_MS = 10_000;

const config = loadConfig(process.env);
const telemetryConfig = loadTelemetryConfig(process.env, config.process);
const telemetry = initTelemetry(telemetryConfig);
// Answer ratings as Langfuse scores (KOBE-275): only with a Langfuse tracing endpoint, server only.
const scoreSink =
  config.process === "server" ? createLangfuseScoreSink(telemetryConfig) : undefined;
// Object storage (s3.*): workspace sync (KOBE-27), thread export and retention (KOBE-18).
const s3 = loadS3Settings(process.env);
const objectStore = s3 ? createS3ObjectStore(s3) : undefined;
// Upload limits and the default team storage quota (KOBE-143); invalid values fail the start.
const uploadSettings = loadUploadSettings(process.env);
// Model gateway (KOBE-40): undefined without the chart's Bifrost settings (models off).
const modelsConfig = config.process === "server" ? loadModelsConfig(process.env) : undefined;
// Header injection (KOBE-39): undefined without the chart's header secret (off).
const egressHeaderSecrets =
  config.process === "server" ? loadEgressHeaderSecrets(process.env) : undefined;
// Site envelope key (KOBE-107): seals per-record secrets (connector credentials, KOBE-108).
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
// Relayed sandbox spans (KOBE-274): `k_trace` from the same session key; unset: no span relay.
const traceSpanKey = traceSpanKeyFromEnv(process.env);
// The server's own model calls (KOBE-219 auto-titles): the gateway's address and a token key from
// the same session key. Either unset: no titles (logged once below).
const serverCallKey = serverCallKeyFromEnv(process.env);
// The wire is built before the sandbox provider exists: its waker is set once the provider is.
const waker = createDeferredWaker();
const isServer = config.process === "server";
let deps: ServerDeps | undefined;
if (config.process === "scheduler") {
  // KOBE-174: the scheduler fires runs through the same orchestrator and sandbox wire router.
  deps = createServerDeps({
    databaseUrl: config.databaseUrl,
    ...schedulerAuthStandIn(),
    // No run-token key: the wire host that delivers run.start mints run tokens, not the scheduler.
    sandboxWire: { waker },
    connectors: loadConnectorUrlPolicy(process.env),
    agents: { maxVersions: config.agentMaxVersions },
    modelTokenDefaults: config.modelTokenDefaults,
    uploads: uploadSettings,
  });
} else if (config.auth && config.smtp) {
  const { approvalKey, ...auth } = config.auth;
  deps = createServerDeps({
    databaseUrl: config.databaseUrl,
    retentionPaused: config.retentionPaused,
    brandingDefaults: config.branding ?? {},
    ...auth,
    ...(approvalKey ? { approvalKeys: approvalKeyring(approvalKey) } : {}),
    mailer: createSmtpMailer(config.smtp),
    sandboxWire: {
      waker,
      ...(runTokenKey ? { runTokenKey } : {}),
      ...(traceSpanKey ? { traceSpanKey } : {}),
    },
    ...(config.modelGatewayUrl && serverCallKey
      ? { serverCalls: { gatewayUrl: config.modelGatewayUrl, key: serverCallKey } }
      : {}),
    connectors: loadConnectorUrlPolicy(process.env),
    auditForwardingDestinations: destinationsOf(config.auditForwarding),
    auditForwardingSecrets: forwardingSecrets(config.auditForwarding),
    ...(config.mcpProxyUrl && config.mcpProxyInternalKey
      ? {
          connectorProbe: createProxyProbe({
            baseUrl: config.mcpProxyUrl,
            internalKey: config.mcpProxyInternalKey,
            timeoutMs: PROBE_TIMEOUT_MS,
          }),
          appCaller: createProxyAppCaller({
            baseUrl: config.mcpProxyUrl,
            internalKey: config.mcpProxyInternalKey,
            timeoutMs: PROBE_TIMEOUT_MS,
          }),
        }
      : {}),
    agents: { maxVersions: config.agentMaxVersions },
    modelTokenDefaults: config.modelTokenDefaults,
    ...(egressHeaderSecrets ? { egressHeaderSecrets } : {}),
    ...(envelope ? { envelope } : {}),
    ...(scoreSink
      ? {
          feedbackScores: { sink: scoreSink, captureContent: telemetryConfig.captureContent },
        }
      : {}),
    ...(s3 && objectStore ? { blobs: { objects: objectStore, prefix: s3.prefix } } : {}),
    uploads: uploadSettings,
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
  if (!config.modelGatewayUrl || !serverCallKey) {
    logger.info("model gateway or its session key not configured: threads are not auto-titled");
  }
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

// Gallery agents (KOBE-87), the chart's branding defaults while unset (KOBE-503) and Kobe's own
// catalog skills (KOBE-317), seeded at every start before the server serves (startup/jobs.ts); a
// failure is logged and never stops the server.
const startSeeds =
  deps && config.process === "server" ? await seedAtStart(deps, logger) : undefined;

// KOBE-425: sealed values whose key this server does not hold (a restore with other Secrets) are
// named at start, with the Secret to put back. Reads key ids only; never stops the start.
if (deps && config.process === "server") {
  const families = sealedFamilies({
    ...(modelsConfig
      ? {
          providerKeyIds: new SecretBox(modelsConfig.providerKeySecrets, PROVIDER_KEY_PURPOSE)
            .keyIds,
          virtualKeyIds: new SecretBox(modelsConfig.virtualKeySecrets, VIRTUAL_KEY_PURPOSE).keyIds,
        }
      : {}),
    ...(envelope ? { envelopeKeyIds: envelope.keyIds } : {}),
    ...(egressHeaderSecrets ? { egressHeaderKeyIds: headerBox(egressHeaderSecrets).keyIds } : {}),
  });
  await checkSealedKeys(deps.database.db, families, logger).catch((err: unknown) =>
    logger.error({ err }, "the sealed key check failed"),
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
// The scheduler only fires runs: the server's background jobs below run on server replicas.
const serverDeps = isServer ? deps : undefined;
isolation.start().catch((err: unknown) => logger.error({ err }, "isolation check failed"));

if (config.process === "server" && !egressHeaderSecrets) {
  logger.warn("KOBE_EGRESS_HEADER_SECRET is not set: egress header injection is off");
}
if (config.process === "server" && !envelope) {
  logger.warn("KOBE_ENVELOPE_KEY is not set: connector credentials cannot be stored");
}
if (config.process === "server" && !modelsConfig) {
  logger.warn("KOBE_BIFROST_URL is not set: the model gateway is not configured");
}

// Sandbox provider (KOBE-22): the server and the scheduler (scheduled runs, KOBE-174) both start
// sandboxes through it.
// The scheduler gets the provider only: it wakes sandboxes but holds no session-token key (tokens
// are signed on the server's sandbox listener and wire), so a compromised scheduler can't forge them.
const sandbox = isServer
  ? createSandboxRuntime(process.env, isolation, deps?.database.db)
  : undefined;
const providerRuntime =
  sandbox ??
  (isServer
    ? undefined
    : createSandboxRuntime(process.env, isolation, deps?.database.db, { providerOnly: true }));
if (!providerRuntime) {
  logger.error(
    "KOBE_SANDBOX_CONFIG is not set: sandboxes are disabled (install with the Helm chart)",
  );
}

// Workspace sync (KOBE-27): /workspace ↔ S3, brokered by the server on the sandbox listener so
// sandboxes never hold object-store credentials. Off without a bucket (s3.bucket) or when disabled.
const syncSettings = sandbox?.settings.workspaceSync;
const workspaceSync =
  isServer && sandbox && deps && s3 && objectStore && syncSettings?.enabled
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
        teamStorageDefaultBytes: uploadSettings.defaultQuotaBytes,
        paused: config.retentionPaused,
        log: logger,
      })
    : undefined;
// Message attachments (KOBE-144) need the workspace store; without it `file_ids` are refused.
if (workspaceSync && deps) {
  // Project files are mounted into members' workspaces through the same store (KOBE-162).
  deps.projectMounts.use(workspaceSync);
  // `save_skill_draft` reads the pushed skill folder from the same store (KOBE-442).
  deps.skillDraftTool.use(workspaceSync);
  // Notebook cells and their outputs (KOBE-464) live in the same store.
  deps.notebookFiles.use(workspaceSync);
  deps.runs.useAttachments(
    createAttachmentStager({ db: deps.database.db, sync: workspaceSync, settings: uploadSettings }),
  );
  // A message's viewed file (KOBE-462) is read from the member's synced workspace.
  deps.runs.useViewing(createViewingReader(deps.database.db, workspaceSync));
}
if (sandbox && syncSettings?.enabled && !s3) {
  logger.warn("object storage is not configured (s3.bucket): workspace sync is off");
}
/** Workspace sync's caller checks; revocations (deactivation, removal) clear its cache. */
function workspaceAuth(d: ServerDeps, s: NonNullable<typeof sandbox>, allowEval = false) {
  const authenticate = createSandboxAuthenticator({
    allowEval,
    db: d.database.db,
    verify: sandboxWireVerifier(s.sessionVerifyKeys),
    // Short positive cache: a destroyed or replaced sandbox loses access within 5 s.
    liveness: providerLiveness(s.provider, d.database.db, 5_000),
  });
  d.sandboxWire.onUserRevalidate((userId) => authenticate.forget(userId));
  return authenticate;
}
// One caller check for every sandbox-listener HTTP endpoint (workspace sync, skill bundles).
const sandboxAuth = sandbox && deps ? workspaceAuth(deps, sandbox) : undefined;
// Skill bundles and eval fixtures also serve a skill eval's own sandbox (KOBE-325); workspace
// sync never does.
const evalCapableAuth = sandbox && deps ? workspaceAuth(deps, sandbox, true) : undefined;
const stopCollector = workspaceSync?.startCollector((syncSettings?.collectSeconds ?? 3600) * 1000);

// Pre-publish Orbit evals (KOBE-93): Jobs in team namespaces, through the sandbox provider.
const evalRunner =
  isServer && sandbox && deps
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

// The optional external skill scanner (KOBE-341): a Job per Registry submission while a Site
// admin has it on; any replica finishes scans whose driver died with its server.
const externalScan =
  isServer && sandbox && deps?.blobs
    ? new ExternalScanRunner({
        db: deps.database.db,
        blobs: deps.blobs,
        kube: sandbox.kube,
        provider: sandbox.provider,
        isolation,
        settings: sandbox.settings,
      })
    : undefined;
const externalScanSweep = externalScan
  ? setInterval(() => {
      externalScan
        .sweep()
        .catch((err: unknown) => logger.warn({ err }, "external skill scan sweep failed"));
    }, EVAL_SWEEP_MS)
  : undefined;
externalScanSweep?.unref();

// The optional git mirror of the catalog (KOBE-343): off until a Site admin names a remote. It
// pushes through the egress proxy with a site egress token; the remote's token comes from the
// chart's Secret. Kicked on approvals and settings changes; swept for retries.
const skillMirrorConfig = isServer ? loadSkillMirrorConfig(process.env) : undefined;
const skillMirror =
  isServer && deps?.blobs && skillMirrorConfig
    ? new SkillMirror({
        db: deps.database.db,
        pool: deps.database.pool,
        blobs: deps.blobs,
        credentials: skillMirrorConfig.credentials,
        egress: sandbox
          ? {
              proxyUrl: egressProxyUrl(sandbox.settings),
              key: sandbox.sessionKeys["kobe.egress-proxy"],
            }
          : null,
        author: skillMirrorConfig.author,
      })
    : undefined;
const skillMirrorSweep = skillMirror
  ? setInterval(() => skillMirror.kick(), SKILL_MIRROR_SWEEP_MS)
  : undefined;
skillMirrorSweep?.unref();
skillMirror?.kick();

// Skill evals (KOBE-325): every server replica runs eval executions in ephemeral sandboxes (the
// per-team cap is atomic across replicas), streams progress, and one replica at a time reaps what
// a dead replica left. Needs the sandbox provider and object storage.
const skillEvalHub = isServer && deps ? new SkillEvalHub(config.databaseUrl, logger) : undefined;
skillEvalHub?.start();
const skillEvalRunner =
  isServer && sandbox && deps?.blobs
    ? new SkillEvalRunner({
        db: deps.database.db,
        blobs: deps.blobs,
        router: deps.sandboxWire.router,
        runs: deps.runs,
        provider: sandbox.provider,
        maxConcurrentPerTeam: sandbox.settings.skillEval.maxConcurrentPerTeam,
        log: logger,
        // KOBE-326: without server calls a `judge` check fails `judge_failed`.
        ...(deps.skillEvalJudge ? { judge: deps.skillEvalJudge } : {}),
      })
    : undefined;
const kickSkillEvals = () =>
  void skillEvalRunner
    ?.sweep()
    .catch((err: unknown) => logger.warn({ err }, "skill eval sweep failed"));
const skillEvalSweep = skillEvalRunner
  ? setInterval(kickSkillEvals, SKILL_EVAL_SWEEP_MS)
  : undefined;
skillEvalSweep?.unref();
const skillEvalReaperLock =
  skillEvalRunner && deps && sandbox
    ? createPgReconcileLock(
        deps.database.pool,
        (err) => logger.warn({ err }, "skill eval reaper lock connection problem"),
        SKILL_EVAL_REAPER_LOCK,
      )
    : undefined;
const skillEvalReaper =
  skillEvalReaperLock && deps && sandbox
    ? setInterval(() => {
        skillEvalReaperLock
          .runExclusive(() =>
            reapSkillEvals({
              db: deps.database.db,
              provider: sandbox.provider,
              runs: deps.runs,
              log: logger,
            }),
          )
          .catch((err: unknown) => logger.warn({ err }, "skill eval reaper failed"));
      }, SKILL_EVAL_REAPER_MS)
    : undefined;
skillEvalReaper?.unref();

// The scheduler serves health endpoints only: no user API (it has no auth), just its runner below.
const server = serve(
  {
    fetch: createApp(isServer ? deps : undefined, {
      isolation,
      ...(evalRunner ? { evals: evalRunner } : {}),
      ...(externalScan ? { externalScan } : {}),
      ...(skillMirror ? { skillMirror } : {}),
      // Governed skill import (KOBE-344): fetched through the egress proxy with a site token.
      ...(sandbox
        ? {
            skillImport: {
              http: (url: string, deadlineAt: number) =>
                mirrorHttpClient({
                  deadlineAt,
                  remote: url,
                  credentials: null,
                  proxy: {
                    url: egressProxyUrl(sandbox.settings),
                    token: () =>
                      signSiteEgressToken("skill-import", sandbox.sessionKeys["kobe.egress-proxy"]),
                  },
                  maxResponseBytes: IMPORT_FETCH_MAX_BYTES,
                }),
            },
          }
        : {}),
      ...(workspaceSync ? { workspaceFiles: { sync: workspaceSync, waker } } : {}),
      skillEvals: {
        ...(skillEvalHub ? { hub: skillEvalHub } : {}),
        ...(skillEvalRunner ? { kick: kickSkillEvals } : {}),
      },
    }).fetch,
    port: config.port,
  },
  (info) => {
    logger.info({ port: info.port, process: config.process }, "listening");
  },
);

// Sandbox-facing listener: the only server port the sandbox NetworkPolicy allows (no user API).
// Aborted at shutdown so held session long-polls (KOBE-417) answer at once.
const sandboxClosing = new AbortController();
const sandboxServer =
  isServer && sandbox
    ? serve(
        {
          fetch: createSandboxApp({
            ...sandbox,
            sessionTokenTtlSeconds: config.sessionTokenTtlSeconds,
            closing: sandboxClosing.signal,
            ...(workspaceSync && sandboxAuth
              ? { workspace: workspaceSync.routes(sandboxAuth) }
              : {}),
            // Skill bundles (KOBE-82): served from the same object store, to live sandboxes only.
            ...(deps?.blobs && evalCapableAuth
              ? {
                  skills: skillSandboxRoutes({
                    db: deps.database.db,
                    blobs: deps.blobs,
                    authenticate: evalCapableAuth,
                    log: logger,
                  }),
                  evalFixtures: skillEvalFixtureRoutes({
                    db: deps.database.db,
                    blobs: deps.blobs,
                    authenticate: evalCapableAuth,
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
    verify: sandboxWireVerifier(sandbox.sessionVerifyKeys),
    liveness,
  });
}
// Internal listener (KOBE-58): the MCP proxy's policy re-check. Its own port, admitted by the
// release NetworkPolicy from the MCP proxy only, and keyed (routes/internal.ts).
const internalServer =
  isServer && sandbox && deps && liveness && config.mcpProxyInternalKey
    ? serve(
        {
          fetch: createInternalApp({
            internalKey: config.mcpProxyInternalKey,
            mcp: deps.mcp,
            appResults: deps.appResults,
            auth: {
              db: deps.database.db,
              sessionVerifyKeys: sandbox.sessionVerifyKeys["kobe.mcp-proxy"],
              liveness,
            },
          }).fetch,
          port: config.internalPort,
        },
        (info) => logger.info({ port: info.port }, "internal listener"),
      )
    : undefined;
if (isServer && sandbox && deps && !config.mcpProxyInternalKey) {
  logger.error(
    "KOBE_MCP_PROXY_INTERNAL_KEY is not set: MCP calls are refused (install with the chart)",
  );
}
// Hibernation and wake (KOBE-25, D14): the router wakes sandboxes it finds disconnected; every
// replica sweeps for idle ones (the sandboxes row lock keeps replicas from colliding).
if (providerRuntime && deps) deps.offboarding.setProvider(providerRuntime.provider);
// The server replica's own background jobs (startup/jobs.ts, KOBE-422): audit anchor, PII erasure,
// SIEM forwarding, break-glass, retention, approvals, budgets, email sweeps, egress relay,
// offboarding, connector refresh, header re-seal and the Bifrost sync. Started after the
// offboarding sweep has its sandbox provider (just above): its first pass deletes volumes.
const stopServerJobs = serverDeps
  ? startServerJobs(
      serverJobs({
        deps: serverDeps,
        databaseUrl: config.databaseUrl,
        logger,
        auditForwarding: config.auditForwarding,
        retention: {
          hourUtc: config.retentionHourUtc,
          paused: config.retentionPaused,
          uploadOrphanHours: uploadSettings.orphanHours,
        },
        connectorRefreshSeconds: config.connectorRefreshSeconds,
        models:
          modelsConfig && bifrostAdmin ? { config: modelsConfig, admin: bifrostAdmin } : undefined,
      }),
    )
  : undefined;
const lifecycle =
  providerRuntime && deps
    ? createSandboxLifecycle({
        db: deps.database.db,
        provider: providerRuntime.provider,
        idleMinutes: providerRuntime.settings.hibernation.idleMinutes,
        // A returning member's offboarded sandbox is replaced by a new one (KOBE-28, D12).
        reinstate: (target) => deps.offboarding.reinstate(target),
      })
    : undefined;
if (lifecycle) waker.set(lifecycle.waker);
// Team namespaces follow the server version (KOBE-115): reconciled at start and on an interval,
// one replica at a time. Awake sandboxes under changed NetworkPolicies are flagged, not killed.
const stopTeamReconciler =
  isServer && sandbox && deps
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
const stopHibernation =
  isServer && lifecycle && sandbox?.settings.hibernation.enabled
    ? lifecycle.start(sandbox.settings.hibernation.sweepSeconds * 1000)
    : undefined;
// Deletes sandbox pods found outside the verified isolation runtime (startup + every minute).
const stopReconciler = (isServer ? sandbox : undefined)?.startReconciler((result) => {
  if (result.deleted.length > 0) {
    logger.error(
      { deleted: result.deleted, reason: result.reason },
      "deleted unverified sandbox pods",
    );
  }
});

// Scheduled runs (KOBE-174, D32): every scheduler replica ticks; each due occurrence is claimed
// under a row lease and a unique index, so it fires exactly once across replicas. Without a sandbox
// provider (KOBE_SANDBOX_CONFIG) nothing could run, so the runner stays off rather than creating
// runs that fail.
const schedulerRunner =
  !isServer && deps && providerRuntime
    ? new SchedulerRunner({
        db: deps.database.db,
        runs: deps.runs,
        graceMs: config.scheduler.graceMinutes * 60_000,
      })
    : undefined;
schedulerRunner?.start(config.scheduler.tickSeconds * 1000);
// A scheduled run ended (KOBE-174 hook): its notification and queued email were written with the
// end (KOBE-179); send the email now rather than at the next sweep. Never throws.
const stopRunHook = deps
  ? onScheduledRunEnded(deps.runs, (t) => {
      logger.debug({ run_id: t.run.run_id, status: t.to }, "scheduled run ended");
      void deliverNotificationEmails(deps, t.run.team_id);
    })
  : undefined;

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
  schedulerRunner?.stop();
  void stopServerJobs?.();
  stopRunHook?.();
  startSeeds?.stop();
  stopReconciler?.();
  stopTeamReconciler?.();
  if (evalSweep) clearInterval(evalSweep);
  if (externalScanSweep) clearInterval(externalScanSweep);
  if (skillMirrorSweep) clearInterval(skillMirrorSweep);
  if (skillEvalSweep) clearInterval(skillEvalSweep);
  if (skillEvalReaper) clearInterval(skillEvalReaper);
  // Running eval executions go back to queued (another replica takes them), their runs stopped
  // and sandboxes deleted, before the database pool closes (review M2).
  const evalsStopped = skillEvalRunner?.shutdown(DRAIN_TIMEOUT_MS - 2_000) ?? Promise.resolve();
  void skillEvalHub?.close();
  stopHibernation?.();
  stopCollector?.();
  sandboxClosing.abort();
  sandboxServer?.close();
  internalServer?.close();
  // End event streams first so browsers reconnect (with Last-Event-ID) to another replica.
  void deps?.eventStream.hub.close();
  server.close((err) => {
    if (err) logger.error({ err }, "shutdown error");
    void evalsStopped
      .catch(() => undefined)
      .then(() => Promise.all([deps?.close(), telemetry.shutdown()]))
      .finally(() => process.exit(err ? 1 : 0));
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    setTimeout(() => process.exit(1), 1_000).unref();
  }, DRAIN_TIMEOUT_MS).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
