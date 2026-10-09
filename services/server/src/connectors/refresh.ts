import {
  SYSTEM_ACTOR,
  and,
  connectors,
  eq,
  isNotNull,
  isNull,
  parseToolsSnapshot,
  sql,
  type KobeDb,
} from "@kobe/db";
import { canonicalJson } from "@kobe/protocol";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import type { ReconcileLock } from "../sandbox/reconcile-lock.js";
import { applyDrift, approvedHash } from "./drift.js";
import { buildSnapshot } from "./pin.js";
import type { ConnectorProbe } from "./probe.js";

/**
 * Periodic refresh (KOBE-102, spec D27): re-probes every pinned, active connector through the MCP
 * proxy and applies {@link applyDrift}. A connector whose probe fails, or whose live list cannot be
 * pinned unambiguously, keeps its snapshot as it was (a failure never offers anything new). One
 * server replica at a time runs a pass (advisory lock); a connector is written only if it still
 * has the probed URL, under a row lock, so an admin edit during the probe wins.
 */
export const CONNECTOR_REFRESH_LOCK = "kobe.connector-refresh";

export type RefreshOutcome =
  | { readonly status: "unchanged" }
  | {
      readonly status: "drifted";
      readonly changed: number;
      readonly added: number;
      readonly removed: number;
    }
  | { readonly status: "skipped"; readonly reason: string };

const skipped = (reason: string): RefreshOutcome => ({ status: "skipped", reason });

const refreshable = (connectorId: string) =>
  and(
    eq(connectors.id, connectorId),
    eq(connectors.status, "active"),
    isNull(connectors.deletedAt),
    isNotNull(connectors.toolsHash),
  );

export async function refreshConnector(
  db: KobeDb,
  prober: ConnectorProbe,
  connectorId: string,
): Promise<RefreshOutcome> {
  const [row] = await db
    .select({ name: connectors.name, url: connectors.url })
    .from(connectors)
    .where(refreshable(connectorId));
  if (!row) return skipped("not_pinned");

  const probed = await prober.probe(row.url);
  if (!probed.ok) return skipped(probed.failure);
  const live = buildSnapshot(row.name, probed.tools);
  if (!live.ok) return skipped(live.failure);

  return db.transaction(async (tx): Promise<RefreshOutcome> => {
    const [locked] = await tx
      .select({ url: connectors.url, name: connectors.name, snapshot: connectors.toolsSnapshot })
      .from(connectors)
      .where(refreshable(connectorId))
      .for("update");
    if (!locked || locked.url !== row.url) return skipped("changed");

    const before = parseToolsSnapshot(locked.snapshot);
    const drift = applyDrift(before, live.tools);
    const events = drift.changed.length + drift.added.length + drift.removed.length;
    // A drifted tool returning to its approval rewrites the rows without being an event.
    if (events === 0 && canonicalJson(drift.tools) === canonicalJson(before)) {
      return { status: "unchanged" };
    }
    await tx
      .update(connectors)
      .set({
        toolsSnapshot: drift.tools,
        toolsHash: approvedHash(drift.tools),
        updatedAt: sql`now()`,
      })
      .where(eq(connectors.id, connectorId));
    if (events === 0) return { status: "unchanged" };
    await recordAudit(tx, {
      action: "mcp.connector.drift",
      actor: SYSTEM_ACTOR,
      target: {
        connectorId,
        name: locked.name,
        changed: drift.changed,
        added: drift.added,
        removed: drift.removed,
      },
    });
    return {
      status: "drifted",
      changed: drift.changed.length,
      added: drift.added.length,
      removed: drift.removed.length,
    };
  });
}

export interface RefreshSummary {
  readonly checked: number;
  readonly drifted: number;
  readonly skipped: number;
  readonly failed: number;
}

/** One pass over every pinned, active connector. A failure on one is logged, never stops the rest. */
export async function refreshAllConnectors(
  db: KobeDb,
  prober: ConnectorProbe,
  logger: Pick<Logger, "warn" | "info">,
): Promise<RefreshSummary> {
  const ids = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.status, "active"),
        isNull(connectors.deletedAt),
        isNotNull(connectors.toolsHash),
      ),
    );
  let drifted = 0;
  let skippedCount = 0;
  let failed = 0;
  for (const { id } of ids) {
    try {
      const outcome = await refreshConnector(db, prober, id);
      if (outcome.status === "drifted") drifted += 1;
      if (outcome.status === "skipped") {
        skippedCount += 1;
        logger.info({ connectorId: id, reason: outcome.reason }, "connector refresh skipped");
      }
    } catch (err) {
      failed += 1;
      logger.warn({ err, connectorId: id }, "connector refresh failed");
    }
  }
  return { checked: ids.length, drifted, skipped: skippedCount, failed };
}

export interface ConnectorRefreshOptions {
  readonly db: KobeDb;
  readonly prober: ConnectorProbe;
  readonly lock: ReconcileLock;
  readonly intervalMs: number;
  readonly logger: Logger;
}

/** Starts the interval; returns the stop function. `intervalMs <= 0` starts nothing. */
export function startConnectorRefresh(options: ConnectorRefreshOptions): () => void {
  if (options.intervalMs <= 0) return () => undefined;
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    options.lock
      .runExclusive(() => refreshAllConnectors(options.db, options.prober, options.logger))
      .then((outcome) => {
        if (outcome.ran) options.logger.info(outcome.value, "connectors refreshed");
      })
      .catch((err: unknown) => options.logger.warn({ err }, "connector refresh pass failed"))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
