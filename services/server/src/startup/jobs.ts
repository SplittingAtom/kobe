import {
  KEY_FINGERPRINT_PURPOSE,
  PROVIDER_KEY_PURPOSE,
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  deriveKey,
} from "@kobe/db";
import type { Logger } from "pino";
import { AUDIT_FORWARD_LOCK, AuditForwarder } from "../audit/forward/forwarder.js";
import type { AuditForwardingConfig } from "../audit/forward/config.js";
import { destinationsOf, sinksFor } from "../audit/forward/index.js";
import { forwardingSecrets } from "../audit/forward/redact.js";
import { AuditPiiSweeper } from "../audit/pii-sweeper.js";
import { BreakGlassSweeper, sweepBreakGlass } from "../break-glass/sweeper.js";
import { notifyDrift } from "../connectors/drift-notify.js";
import {
  CONNECTOR_REFRESH_LOCK,
  refreshAllConnectors,
  startConnectorRefresh,
} from "../connectors/refresh.js";
import type { ServerDeps } from "../deps.js";
import { EgressBlockedRelay } from "../egress/blocked-relay.js";
import { resealTeamHeaders } from "../egress/header-store.js";
import { EgressRequestSweeper, sweepEgressRequestNotifications } from "../egress/request-notify.js";
import { seedGalleryAgents } from "../gallery/seed.js";
import type { BifrostAdmin } from "../models/bifrost-admin.js";
import type { ModelsConfig } from "../models/config.js";
import { ModelGatewaySync } from "../models/sync.js";
import { NotificationEmailSweeper, sweepNotificationEmails } from "../notifications/email.js";
import { OFFBOARDING_SWEEP_LOCK } from "../offboarding/index.js";
import { RetentionJob } from "../retention/job.js";
import { createPgReconcileLock } from "../sandbox/reconcile-lock.js";

const OFFBOARDING_SWEEP_MS = 10 * 60_000;

/**
 * The server process's own start-up work (KOBE-422): what a server replica writes to Postgres
 * when it starts, with nobody signed in. `index.ts` starts these; `startup-seeds.db.test.ts` runs
 * one pass of each on a fresh database to prove that everything they write there is a startup
 * seed `kobe restore` replaces (`@kobe/db` STARTUP_SEEDED_ROWS). Jobs that need the sandbox
 * provider (team reconcile, hibernation, the pod reconciler, workspace collection, Orbit evals)
 * stay in `index.ts`: they act on teams' sandboxes, which a fresh site has none of.
 */
export interface ServerJob {
  readonly name: string;
  /** Starts the job's own schedule (its first pass now or soon); returns how to stop it. */
  start(): () => unknown;
  /** One pass now, as the schedule's would be (the start-up guard test). */
  once(): Promise<unknown>;
}

export interface ServerJobsOptions {
  readonly deps: ServerDeps;
  /** Direct (or session-mode) Postgres URL for LISTEN connections. */
  readonly databaseUrl: string;
  readonly logger: Logger;
  readonly auditForwarding: AuditForwardingConfig;
  readonly retention: {
    readonly hourUtc: number;
    readonly paused: boolean;
    readonly uploadOrphanHours: number;
  };
  readonly connectorRefreshSeconds: number;
  /** Bifrost config sync (KOBE-40): only with the chart's models settings. */
  readonly models?: { readonly config: ModelsConfig; readonly admin: BifrostAdmin } | undefined;
}

/** Work done once, awaited, before the server serves: the gallery (KOBE-87, every start). */
export async function seedAtStart(deps: ServerDeps, logger: Logger): Promise<void> {
  await seedGalleryAgents(deps.database.db).catch((err: unknown) =>
    logger.error({ err }, "gallery agents could not be seeded"),
  );
}

const lockFor = (o: ServerJobsOptions, name: string, what: string) =>
  createPgReconcileLock(
    o.deps.database.pool,
    (err) => o.logger.warn({ err }, `${what} lock connection problem`),
    name,
  );

/** Each job as a value: built once, started or run once. */
function job(name: string, start: () => () => unknown, once: () => Promise<unknown>): ServerJob {
  return { name, start, once };
}

function auditJobs(o: ServerJobsOptions): ServerJob[] {
  const { deps } = o;
  const db = deps.database.db;
  const jobs: ServerJob[] = [
    // Audit chain head in the server log at startup and every 5 minutes (KOBE-15).
    job(
      "audit-anchor",
      () => {
        deps.auditAnchor.start();
        return () => deps.auditAnchor.stop();
      },
      () => deps.auditAnchor.tick(),
    ),
  ];
  // Audit rows lose their client IP and user agent after the retention period (KOBE-17).
  const pii = new AuditPiiSweeper(db);
  jobs.push(
    job(
      "audit-pii",
      () => {
        pii.start();
        return () => pii.stop();
      },
      () => pii.runOnce(),
    ),
  );
  // Optional SIEM forwarding (syslog, OTLP; KOBE-19): one replica forwards at a time.
  if (destinationsOf(o.auditForwarding).length > 0) {
    const forwarder = new AuditForwarder({
      db,
      sinks: sinksFor(o.auditForwarding),
      lock: lockFor(o, AUDIT_FORWARD_LOCK, "audit forwarding"),
      log: o.logger,
      secrets: forwardingSecrets(o.auditForwarding),
    });
    jobs.push(
      job(
        "audit-forwarding",
        () => {
          forwarder.start();
          return () => forwarder.stop();
        },
        () => forwarder.runOnce(),
      ),
    );
  }
  return jobs;
}

function sweepJobs(o: ServerJobsOptions): ServerJob[] {
  const { deps } = o;
  const db = deps.database.db;
  // Break-glass grants end at expires_at on their own; this records the end (KOBE-16).
  const breakGlass = new BreakGlassSweeper(deps);
  // Nightly retention (KOBE-18, D18); an advisory lock lets one replica run a pass.
  const retention = new RetentionJob({
    db,
    pool: deps.database.pool,
    blobs: deps.blobs,
    uploadOrphanHours: o.retention.uploadOrphanHours,
    hourUtc: o.retention.hourUtc,
    paused: o.retention.paused,
    logger: o.logger,
  });
  // Request-access (KOBE-39) and scheduled-run (KOBE-179) emails: retries and leftovers.
  const egressRequests = new EgressRequestSweeper(deps);
  const notificationEmails = new NotificationEmailSweeper(deps);
  return [
    job(
      "break-glass",
      () => {
        breakGlass.start();
        return () => breakGlass.stop();
      },
      () => sweepBreakGlass(deps),
    ),
    job(
      "retention",
      () => {
        retention.start();
        return () => retention.stop();
      },
      () => retention.tick(),
    ),
    // Pending approvals past their 1 h TTL whose waiting replica is gone (D29, KOBE-37).
    job(
      "approvals",
      () => {
        deps.approvals.start();
        return () => deps.approvals.stop();
      },
      () => deps.approvals.sweep(),
    ),
    // Budgets: spend hints from the model gateway and a sweep over every team (KOBE-42).
    job(
      "budgets",
      () => {
        deps.budgets.start();
        return () => undefined; // closed with the deps (deps.close)
      },
      () => deps.budgets.sweep(),
    ),
    job(
      "egress-requests",
      () => {
        egressRequests.start();
        return () => egressRequests.stop();
      },
      () => sweepEgressRequestNotifications(deps),
    ),
    job(
      "notification-emails",
      () => {
        notificationEmails.start();
        return () => notificationEmails.stop();
      },
      () => sweepNotificationEmails(deps),
    ),
  ];
}

function siteJobs(o: ServerJobsOptions): ServerJob[] {
  const { deps } = o;
  const db = deps.database.db;
  // Blocked egress attempts → `egress.blocked` run events (KOBE-38); every replica listens.
  const relay = new EgressBlockedRelay({ db, connectionString: o.databaseUrl });
  const jobs: ServerJob[] = [
    job(
      "egress-blocked",
      () => {
        relay.start();
        return () => relay.close();
      },
      () => relay.sweep(),
    ),
    // Departures missed, volumes deleted 30 days after a member left (KOBE-28, D12).
    job(
      "offboarding",
      () =>
        deps.offboarding.start({
          lock: lockFor(o, OFFBOARDING_SWEEP_LOCK, "offboarding sweep"),
          everyMs: OFFBOARDING_SWEEP_MS,
        }),
      () => deps.offboarding.sweep(),
    ),
  ];
  // Connector tool drift (KOBE-102, D27): re-probe pinned connectors, one replica at a time.
  const afterPass = () => notifyDrift({ db, mailer: deps.mailer, publicUrl: deps.publicUrl });
  jobs.push(
    job(
      "connector-refresh",
      () =>
        startConnectorRefresh({
          db,
          prober: deps.connectorProbe,
          lock: lockFor(o, CONNECTOR_REFRESH_LOCK, "connector refresh"),
          intervalMs: o.connectorRefreshSeconds * 1000,
          logger: o.logger,
          afterPass,
        }),
      async () => {
        await refreshAllConnectors(db, deps.connectorProbe, o.logger);
        await afterPass();
      },
    ),
  );
  // Header values sealed with a previous header secret are re-sealed with the current one.
  const box = deps.egressHeaders;
  if (box) {
    const reseal = () =>
      resealTeamHeaders(db, box)
        .then((n) => {
          if (n > 0) o.logger.info({ domains: n }, "egress header values re-sealed");
        })
        .catch((err: unknown) => o.logger.error({ err }, "egress header re-seal failed"));
    jobs.push(
      job(
        "egress-header-reseal",
        () => {
          void reseal();
          return () => undefined;
        },
        reseal,
      ),
    );
  }
  return jobs;
}

function modelJobs(o: ServerJobsOptions): ServerJob[] {
  if (!o.models) return [];
  const { config, admin } = o.models;
  // Bifrost config sync (KOBE-40): every replica listens; one leads and reconciles.
  const sync = new ModelGatewaySync({
    db: o.deps.database.db,
    connectionString: o.databaseUrl,
    admin,
    providerKeys: new SecretBox(config.providerKeySecrets, PROVIDER_KEY_PURPOSE),
    virtualKeys: new SecretBox(config.virtualKeySecrets, VIRTUAL_KEY_PURPOSE),
    // Own HKDF purpose: the fingerprint secret never equals a sealing key.
    fingerprintSecret: deriveKey(
      config.providerKeySecrets[0] ?? "",
      KEY_FINGERPRINT_PURPOSE,
    ).toString("hex"),
    intervalMs: config.syncIntervalMs,
    logger: o.logger,
  });
  return [
    job(
      "model-gateway-sync",
      () => {
        sync.start();
        return () => sync.close();
      },
      () => sync.runOnce(),
    ),
  ];
}

/** Every start-up job of a server replica, in start order. */
export function serverJobs(o: ServerJobsOptions): ServerJob[] {
  return [...auditJobs(o), ...sweepJobs(o), ...siteJobs(o), ...modelJobs(o)];
}

/** Starts the jobs; returns one function that stops them all. */
export function startServerJobs(jobs: readonly ServerJob[]): () => Promise<void> {
  const stops = jobs.map((j) => j.start());
  return async () => {
    await Promise.all(stops.map((stop) => Promise.resolve(stop()).catch(() => undefined)));
  };
}
