import { createDb, isActiveTeamMember, loadEgressCeiling, loadTeamEgress } from "@kobe/db";
import { AddressPolicy } from "./address-policy.js";
import { AllowlistCache } from "./allowlist.js";
import { egressTokenVerifier } from "./auth.js";
import { BlockedReporter, dbBlockedSink } from "./blocked-reporter.js";
import { ChangeListener } from "./change-listener.js";
import { loadConfig } from "./config.js";
import { ConnectionAudit, dbAuditWriter } from "./connection-audit.js";
import { BandwidthLimiter, ConnectionLimits } from "./limits.js";
import { logger } from "./logger.js";
import { createEgressProxy } from "./proxy.js";
import { dnsResolver } from "./resolver.js";

/** Open tunnels get this long to finish on shutdown; stays under k8s' 30 s grace period. */
const DRAIN_TIMEOUT_MS = 20_000;

const config = loadConfig(process.env);
const database = createDb(config.databaseUrl, { max: 10 });
const db = database.db;

const cache = new AllowlistCache(
  {
    loadCeiling: () => loadEgressCeiling(db),
    loadTeam: (teamId) => loadTeamEgress(db, teamId),
    isActiveMember: (teamId, userId) => isActiveTeamMember(db, teamId, userId),
  },
  { ttlMs: config.cacheTtlMs, degradedTtlMs: 5_000, memberTtlMs: 30_000, maxEntries: 10_000 },
);
const listener = new ChangeListener({ connectionString: config.databaseUrl, cache, logger });
listener.start();
const audit = new ConnectionAudit({
  write: dbAuditWriter(db),
  logger,
  flushMs: config.auditFlushMs,
});
audit.start();
const blocked = new BlockedReporter({ sink: dbBlockedSink(db), logger });

let draining = false;
const server = createEgressProxy({
  verify: egressTokenVerifier(config.sessionKey),
  policy: cache,
  resolve: dnsResolver({ timeoutMs: config.dnsTimeoutMs }),
  addresses: new AddressPolicy({
    allowedInternal: config.allowedInternalCidrs,
    extraDenied: config.deniedCidrs,
  }),
  connections: new ConnectionLimits({
    perSandbox: config.maxConnectionsPerSandbox,
    total: config.maxConnections,
  }),
  bandwidth: new BandwidthLimiter(config.bandwidthBytesPerSecond),
  audit,
  blocked,
  logger,
  settings: {
    allowedPorts: config.allowedPorts,
    idleTimeoutMs: config.idleTimeoutMs,
    handshakeTimeoutMs: config.handshakeTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
  },
  ready: () => !draining,
});
// Sockets beyond the tunnel limit (unauthenticated or slow clients) are refused outright.
server.maxConnections = config.maxConnections + 256;
server.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      allowedPorts: config.allowedPorts,
      internalTargets: config.allowedInternalCidrs.length,
    },
    "egress proxy listening",
  );
});

async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => server.closeAllConnections(), DRAIN_TIMEOUT_MS);
  force.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(force);
  await audit.stop();
  await blocked.drain();
  await listener.close();
  await database.close();
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
