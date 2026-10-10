import {
  MODELS_ENSURE_PREFIX,
  MODELS_RESYNC,
  MODELS_SPEND_PREFIX,
  loadGatewayPrices,
  loadMemberBudgetState,
  withTeam,
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  createDb,
  isActiveRunLeasedTo,
  isRunTokenActive,
  loadGatewayPrincipal,
  notifyModels,
  recordModelUsage,
} from "@kobe/db";
import { deriveRunTokenKey } from "@kobe/protocol/node";
import { verifySessionToken } from "@kobe/session-token";
import { initTelemetry, loadTelemetryConfig } from "@kobe/telemetry";
import { loadConfig } from "./config.js";
import { createModelGateway } from "./gateway.js";
import { TtlCache } from "./cache.js";
import { ByteBudget, CallLimiter, RequestRate } from "./limits.js";
import { ModelsListener } from "./listener.js";
import { logger } from "./logger.js";
import { PrincipalCache } from "./principals.js";
import { BudgetGate } from "./budget-gate.js";
import { DbReservations } from "./reservations-db.js";
import { DbUsageSink } from "./usage/sink.js";

/** Open calls get this long to finish on shutdown; stays under k8s' 30 s grace period. */
const DRAIN_TIMEOUT_MS = 20_000;
/** At most one resync request per this period (Bifrost restarts affect every key at once). */
const RESYNC_EVERY_MS = 5_000;

const config = loadConfig(process.env);
const telemetry = initTelemetry(loadTelemetryConfig(process.env, "model-gateway"));
const database = createDb(config.databaseUrl, { max: 10 });
const db = database.db;

const principals = new PrincipalCache(
  {
    load: (teamId, userId, sandboxId) => loadGatewayPrincipal(db, teamId, userId, sandboxId),
    requestKey: (teamId, userId) => notifyModels(db, `${MODELS_ENSURE_PREFIX}${teamId}:${userId}`),
  },
  new SecretBox(config.virtualKeySecret, VIRTUAL_KEY_PURPOSE),
  { ttlMs: config.cacheTtlMs },
);
/** Budgets and per-user rate limits (KOBE-42), enforced before Bifrost. */
const budgets = new BudgetGate(
  {
    load: (teamId, userId) =>
      withTeam(db, teamId, (tx) => loadMemberBudgetState(tx, teamId, userId)),
    prices: () => loadGatewayPrices(db),
  },
  {
    ttlMs: config.budgetCacheTtlMs,
    // Shared by all replicas, with an expiry (KOBE-120).
    reservations: new DbReservations(db, { ttlMs: config.reservationTtlMs }),
    onError: (err) => logger.warn({ err }, "budget reservation could not be ended"),
  },
);
const listener = new ModelsListener({
  connectionString: config.databaseUrl,
  cache: principals,
  budgets,
  logger,
});
listener.start();

/** Run lease answers, positive and negative, cached like principals (single-flight). */
const leases = new TtlCache<boolean>({ ttlMs: Math.max(config.cacheTtlMs, 1_000) });

/**
 * Run token record answers (KOBE-118). A short fixed cache (at most 2 s, whatever the principal
 * cache TTL is) bounds how long an "active" answer outlives revocation; no NOTIFY hint is used.
 */
const tokenRecords = new TtlCache<boolean>({
  ttlMs: Math.min(Math.max(config.cacheTtlMs, 1_000), 2_000),
});

/** The run_usage ledger (KOBE-43): one row per forwarded model call, written in batches. */
const usage = new DbUsageSink({
  write: (records) => recordModelUsage(db, records),
  logger,
  onWritten: (teamId, callIds) => {
    // Drop the cached spend first, then end the calls' reservations: the next check reloads the
    // spend including these rows.
    budgets.invalidateTeam(teamId);
    budgets.settle(teamId, callIds);
    notifyModels(db, `${MODELS_SPEND_PREFIX}${teamId}`).catch((err: unknown) =>
      logger.warn({ err }, "spend hint failed"),
    );
  },
});

let lastResync = 0;
let draining = false;
const server = createModelGateway({
  verify: (token) => verifySessionToken(token, "kobe.model-gateway", config.sessionKey),
  principals,
  isRunLeased: (teamId, runId, sandboxId) =>
    leases.get(`${teamId}:${runId}:${sandboxId}`, () =>
      isActiveRunLeasedTo(db, teamId, runId, sandboxId),
    ),
  runTokens: {
    // Same derivation as the server's: the gateway session key is the shared master secret.
    key: deriveRunTokenKey(new TextEncoder().encode(config.sessionKey)),
    isActive: (s) => tokenRecords.get(`${s.teamId}:${s.jti}`, () => isRunTokenActive(db, s)),
    require: config.requireRunToken,
  },
  bifrostUrl: config.bifrostUrl,
  limiter: new CallLimiter({ perSandbox: config.maxCallsPerSandbox, total: config.maxCalls }),
  bytes: new ByteBudget({
    perSandbox: config.inflightBytesPerSandbox,
    total: config.inflightBytes,
  }),
  rate: new RequestRate({ burst: config.rateBurst, perSecond: config.ratePerSecond }),
  gate: budgets,
  sink: usage,
  onBifrostForgotKey: () => {
    if (Date.now() - lastResync < RESYNC_EVERY_MS) return;
    lastResync = Date.now();
    logger.warn("bifrost refused a known virtual key: requesting a resync");
    notifyModels(db, MODELS_RESYNC).catch((err: unknown) =>
      logger.error({ err }, "resync request failed"),
    );
  },
  logger,
  settings: { maxBodyBytes: config.maxBodyBytes, idleTimeoutMs: config.idleTimeoutMs },
  ready: () => !draining,
});
server.listen(config.port, () => {
  logger.info({ port: config.port }, "model gateway listening");
});

async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => server.closeAllConnections(), DRAIN_TIMEOUT_MS);
  force.unref();
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(force);
  await listener.close();
  await usage.close();
  await database.close();
  await telemetry.shutdown();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((err: unknown) => {
      logger.error({ err }, "shutdown error");
      process.exit(1);
    });
  });
}
